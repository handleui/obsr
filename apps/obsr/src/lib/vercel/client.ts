const VERCEL_API_BASE_URL = "https://api.vercel.com";
const DEFAULT_DEPLOYMENT_LIMIT = 20;
const DEFAULT_RUNTIME_LOG_LIMIT = 100;

interface VercelClientOptions {
  accessToken: string;
}

export interface VercelDeployment {
  createdAt?: number | string;
  id?: string;
  meta?: Record<string, string | undefined>;
  name?: string;
  readyState?: string;
  state?: string;
  target?: string | null;
  uid?: string;
  url?: string;
}

export interface VercelDeploymentEvent {
  created?: number | string;
  id?: string;
  payload?: Record<string, unknown>;
  text?: string;
  type?: string;
}

export interface VercelRuntimeLog {
  domain?: string;
  level?: string;
  message?: string;
  messageTruncated?: boolean;
  requestMethod?: string;
  requestPath?: string;
  requestId?: string;
  responseStatusCode?: number;
  rowId?: string;
  source?: string;
  timestampInMs?: number;
}

const toSearchParams = (input: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }

    params.set(key, String(value));
  }

  return params.toString();
};

const parseJson = async (response: Response) => {
  const text = await response.text();

  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const parseJsonLines = (value: string) => {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as unknown[];
};

const parseStreamPayload = (value: string) => {
  if (!value.trim()) {
    return [];
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return parseJsonLines(value);
  }
};

const toRuntimeLogs = (payload: unknown): VercelRuntimeLog[] => {
  if (Array.isArray(payload)) {
    return payload as VercelRuntimeLog[];
  }

  if (payload && typeof payload === "object") {
    if (Array.isArray((payload as { logs?: unknown[] }).logs)) {
      return (payload as { logs: VercelRuntimeLog[] }).logs;
    }

    if (Array.isArray((payload as { entries?: unknown[] }).entries)) {
      return (payload as { entries: VercelRuntimeLog[] }).entries;
    }
  }

  return [];
};

const toDeploymentEvents = (payload: unknown): VercelDeploymentEvent[] => {
  if (Array.isArray(payload)) {
    return payload as VercelDeploymentEvent[];
  }

  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { events?: unknown[] }).events)
  ) {
    return (payload as { events: VercelDeploymentEvent[] }).events;
  }

  return [];
};

const toDeployments = (payload: unknown): VercelDeployment[] => {
  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { deployments?: unknown[] }).deployments)
  ) {
    return (payload as { deployments: VercelDeployment[] }).deployments;
  }

  return [];
};

export class VercelApiClient {
  readonly #accessToken: string;

  constructor(options: VercelClientOptions) {
    this.#accessToken = options.accessToken;
  }

  private async request(
    path: string,
    query: Record<string, string | number | undefined>
  ) {
    const search = toSearchParams(query);
    const response = await fetch(
      `${VERCEL_API_BASE_URL}${path}${search ? `?${search}` : ""}`,
      {
        headers: {
          Authorization: `Bearer ${this.#accessToken}`,
          "User-Agent": "obsr",
        },
      }
    );

    if (!response.ok) {
      const payload = await parseJson(response);
      const message =
        typeof payload === "string"
          ? payload
          : (payload as { error?: { message?: string } })?.error?.message;
      throw new Error(
        message ?? `Vercel API request failed with ${response.status}.`
      );
    }

    return parseJson(response);
  }

  private async requestJsonLines(
    path: string,
    query: Record<string, string | number | undefined>
  ) {
    const search = toSearchParams(query);
    const response = await fetch(
      `${VERCEL_API_BASE_URL}${path}${search ? `?${search}` : ""}`,
      {
        headers: {
          Accept: "application/stream+json, application/json",
          Authorization: `Bearer ${this.#accessToken}`,
          "User-Agent": "obsr",
        },
      }
    );

    if (!response.ok) {
      const payload = await parseJson(response);
      const message =
        typeof payload === "string"
          ? payload
          : (payload as { error?: { message?: string } })?.error?.message;
      throw new Error(
        message ?? `Vercel API request failed with ${response.status}.`
      );
    }

    return parseStreamPayload(await response.text());
  }

  listDeployments(input: {
    projectId: string;
    teamId: string;
    since?: number;
  }) {
    return this.request("/v6/deployments", {
      limit: DEFAULT_DEPLOYMENT_LIMIT,
      projectId: input.projectId,
      since: input.since,
      teamId: input.teamId,
    }).then(toDeployments);
  }

  listDeploymentEvents(input: { deploymentId: string; teamId: string }) {
    return this.request(`/v3/deployments/${input.deploymentId}/events`, {
      teamId: input.teamId,
    }).then(toDeploymentEvents);
  }

  listRuntimeLogs(input: {
    deploymentId: string;
    projectId: string;
    since?: number;
    teamId: string;
  }) {
    return this.requestJsonLines(
      `/v1/projects/${input.projectId}/deployments/${input.deploymentId}/runtime-logs`,
      {
        limit: DEFAULT_RUNTIME_LOG_LIMIT,
        since: input.since,
        teamId: input.teamId,
      }
    ).then(toRuntimeLogs);
  }
}
