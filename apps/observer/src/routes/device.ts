import type { Context } from "hono";
import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { getBetterAuth } from "../lib/better-auth";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();
type DeviceContext = Context<{ Bindings: Env }>;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const normalizeUserCode = (value: string): string =>
  value.trim().replaceAll(/\s+/g, "").toUpperCase();

const renderPage = (options: {
  userCode?: string;
  status?: string;
  notice?: string;
  error?: string;
  signedIn?: boolean;
}): string => {
  const safeUserCode = options.userCode ? escapeHtml(options.userCode) : "";
  const safeStatus = options.status ? escapeHtml(options.status) : "";
  const safeNotice = options.notice ? escapeHtml(options.notice) : "";
  const safeError = options.error ? escapeHtml(options.error) : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Detent Device Login</title>
  </head>
  <body>
    <main>
      <h1>Detent CLI Device Login</h1>
      ${safeNotice ? `<p>${safeNotice}</p>` : ""}
      ${safeError ? `<p>${safeError}</p>` : ""}
      ${
        safeUserCode
          ? `<p>User code: <strong>${safeUserCode}</strong></p>`
          : "<p>Enter the code from your CLI terminal.</p>"
      }
      ${safeStatus ? `<p>Current status: <strong>${safeStatus}</strong></p>` : ""}
      ${
        safeUserCode
          ? `
      <form method="post" action="/device/approve">
        <input type="hidden" name="user_code" value="${safeUserCode}" />
        <button type="submit">Approve</button>
      </form>
      <form method="post" action="/device/deny">
        <input type="hidden" name="user_code" value="${safeUserCode}" />
        <button type="submit">Deny</button>
      </form>`
          : `
      <form method="get" action="/device">
        <label for="user_code">User code</label>
        <input id="user_code" name="user_code" required />
        <button type="submit">Continue</button>
      </form>`
      }
      ${
        options.signedIn
          ? "<p>You are signed in. Choose approve or deny.</p>"
          : `<form method="post" action="/device/sign-in">
        <input type="hidden" name="user_code" value="${safeUserCode}" />
        <button type="submit">Sign in with GitHub</button>
      </form>`
      }
    </main>
  </body>
</html>`;
};

const getSession = (c: DeviceContext) => {
  const auth = getBetterAuth(c.env);
  return auth.api.getSession({
    headers: c.req.raw.headers,
  });
};

const forwardToAuth = (
  c: DeviceContext,
  path: string,
  init: RequestInit
): Promise<Response> => {
  const auth = getBetterAuth(c.env);
  const url = new URL(`/api/auth${path}`, c.req.url);
  const headers = new Headers(init.headers);
  const cookie = c.req.header("cookie");
  if (cookie) {
    headers.set("cookie", cookie);
  }
  const request = new Request(url.toString(), {
    ...init,
    headers,
  });
  return auth.handler(request);
};

const parseAuthError = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as {
      error_description?: string;
      error?: string;
    };
    return body.error_description ?? body.error ?? "Request failed";
  } catch {
    return "Request failed";
  }
};

const htmlResponse = (
  c: DeviceContext,
  html: string,
  status: number
): Response => {
  return c.newResponse(html, status as StatusCode, {
    "content-type": "text/html; charset=utf-8",
  });
};

app.get("/", async (c) => {
  const userCode = normalizeUserCode(c.req.query("user_code") ?? "");
  const session = await getSession(c);
  const signedIn = Boolean(session?.user?.id);

  if (!userCode) {
    return c.html(renderPage({ signedIn }));
  }

  const verifyResponse = await forwardToAuth(
    c,
    `/device?user_code=${encodeURIComponent(userCode)}`,
    { method: "GET" }
  );

  if (!verifyResponse.ok) {
    const error = await parseAuthError(verifyResponse);
    return htmlResponse(
      c,
      renderPage({
        userCode,
        error,
        signedIn,
      }),
      verifyResponse.status
    );
  }

  const verifyBody = (await verifyResponse.json()) as { status: string };

  return c.html(
    renderPage({
      userCode,
      status: verifyBody.status,
      signedIn,
    })
  );
});

app.post("/sign-in", async (c) => {
  const body = await c.req.parseBody();
  const userCodeRaw = body.user_code;
  const userCode =
    typeof userCodeRaw === "string" ? normalizeUserCode(userCodeRaw) : "";
  const callbackURL = new URL("/device", c.req.url);
  if (userCode) {
    callbackURL.searchParams.set("user_code", userCode);
  }

  const response = await forwardToAuth(c, "/sign-in/social", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "github",
      callbackURL: callbackURL.toString(),
    }),
  });

  if (response.status >= 300 && response.status < 400) {
    return response;
  }

  if (response.ok) {
    try {
      const payload = (await response.json()) as { url?: string };
      if (payload.url) {
        return c.redirect(payload.url);
      }
    } catch {
      return c.redirect(`/device?user_code=${encodeURIComponent(userCode)}`);
    }
  }

  const error = await parseAuthError(response);
  return htmlResponse(
    c,
    renderPage({
      userCode,
      error,
    }),
    response.status
  );
});

app.post("/approve", async (c) => {
  const body = await c.req.parseBody();
  const userCodeRaw = body.user_code;
  const userCode =
    typeof userCodeRaw === "string" ? normalizeUserCode(userCodeRaw) : "";

  if (!userCode) {
    return c.html(
      renderPage({
        error: "Missing user code",
      }),
      400
    );
  }

  const response = await forwardToAuth(c, "/device/approve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userCode,
    }),
  });

  if (response.ok) {
    return c.html(
      renderPage({
        userCode,
        notice: "Device approved. You can return to your terminal.",
        status: "approved",
        signedIn: true,
      })
    );
  }

  const error = await parseAuthError(response);
  const session = await getSession(c);
  return htmlResponse(
    c,
    renderPage({
      userCode,
      error,
      signedIn: Boolean(session?.user?.id),
    }),
    response.status
  );
});

app.post("/deny", async (c) => {
  const body = await c.req.parseBody();
  const userCodeRaw = body.user_code;
  const userCode =
    typeof userCodeRaw === "string" ? normalizeUserCode(userCodeRaw) : "";

  if (!userCode) {
    return c.html(
      renderPage({
        error: "Missing user code",
      }),
      400
    );
  }

  const response = await forwardToAuth(c, "/device/deny", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userCode,
    }),
  });

  if (response.ok) {
    return c.html(
      renderPage({
        userCode,
        notice: "Device denied. You can return to your terminal.",
        status: "denied",
        signedIn: true,
      })
    );
  }

  const error = await parseAuthError(response);
  const session = await getSession(c);
  return htmlResponse(
    c,
    renderPage({
      userCode,
      error,
      signedIn: Boolean(session?.user?.id),
    }),
    response.status
  );
});

export default app;
