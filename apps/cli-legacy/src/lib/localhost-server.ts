import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

interface CallbackResult {
  code: string;
  state: string;
}

interface CallbackServer {
  port: number;
  waitForCallback: () => Promise<CallbackResult>;
  close: () => void;
}

/**
 * Generate HTML success page shown in browser after CLI authorization
 */
const generateSuccessPage = () => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Detent CLI - Authorized</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #fff;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 400px;
    }
    .icon {
      width: 48px;
      height: 48px;
      margin: 0 auto 1.5rem;
      color: #22c55e;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      color: #171717;
      margin-bottom: 0.5rem;
    }
    p {
      font-size: 0.875rem;
      color: #737373;
    }
  </style>
</head>
<body>
  <div class="container">
    <svg class="icon" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
    <h1>Authorized Successfully</h1>
    <p>You can close this tab and return to the terminal.</p>
  </div>
</body>
</html>`;

/**
 * Start a temporary localhost server to receive OAuth callback
 * Optimized for fast shutdown by tracking and destroying connections
 */
export const startCallbackServer = (
  expectedState: string
): Promise<CallbackServer> => {
  return new Promise((resolve, reject) => {
    let callbackPromiseResolve: (result: CallbackResult) => void;
    let callbackPromiseReject: (error: Error) => void;

    const callbackPromise = new Promise<CallbackResult>((res, rej) => {
      callbackPromiseResolve = res;
      callbackPromiseReject = rej;
    });

    // Track connections for fast shutdown
    const connections = new Set<Socket>();

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        // Show success page with close instructions
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(generateSuccessPage());

        // Verify state
        if (state !== expectedState) {
          callbackPromiseReject(
            new Error("State mismatch - possible CSRF attack")
          );
          return;
        }

        if (!code) {
          callbackPromiseReject(new Error("No authorization code received"));
          return;
        }

        callbackPromiseResolve({ code, state });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // Track connections for fast shutdown
    server.on("connection", (socket: Socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
    });

    // Force-close all connections and shutdown server immediately
    const forceClose = () => {
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      server.close();
    };

    // Use port 0 to get a random available port
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }

      const port = address.port;

      // Set timeout (5 minutes)
      const timeout = setTimeout(
        () => {
          callbackPromiseReject(
            new Error("Authentication timed out. Please try again.")
          );
          forceClose();
        },
        5 * 60 * 1000
      );

      resolve({
        port,
        waitForCallback: async () => {
          try {
            const result = await callbackPromise;
            clearTimeout(timeout);
            return result;
          } finally {
            forceClose();
          }
        },
        close: () => {
          clearTimeout(timeout);
          forceClose();
        },
      });
    });

    server.on("error", reject);
  });
};

/**
 * Generate a cryptographically secure state string
 */
export const generateState = (): string => randomBytes(32).toString("hex");
