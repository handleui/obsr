const MAX_RESOLVE_ID_LENGTH = 128;
const SAFE_RESOLVE_ID_PATTERN = /^[a-zA-Z0-9_\-./]+$/;
const MAX_BATCH_SIZE = 200;

export const ResolverQueueSources = {
  Create: "create",
  Trigger: "trigger",
} as const;

export type ResolverQueueSource =
  (typeof ResolverQueueSources)[keyof typeof ResolverQueueSources];

interface ResolverQueueSinglePayload {
  resolveId: string;
  source: ResolverQueueSource;
}

interface ResolverQueueBatchPayload {
  resolveIds: string[];
  source: ResolverQueueSource;
}

export type ResolverQueuePayload =
  | ResolverQueueSinglePayload
  | ResolverQueueBatchPayload;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeResolveId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_RESOLVE_ID_LENGTH ||
    !SAFE_RESOLVE_ID_PATTERN.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
};

const normalizeSource = (value: unknown): ResolverQueueSource | null => {
  if (
    value === ResolverQueueSources.Create ||
    value === ResolverQueueSources.Trigger
  ) {
    return value;
  }
  return null;
};

export const parseResolverQueuePayload = (
  value: unknown
): ResolverQueuePayload | null => {
  if (!isRecord(value)) {
    return null;
  }

  const keys = Object.keys(value);
  if (
    keys.length === 0 ||
    keys.some(
      (key) => key !== "resolveId" && key !== "resolveIds" && key !== "source"
    )
  ) {
    return null;
  }

  const source = normalizeSource(value.source);
  if (!source) {
    return null;
  }

  const singleResolveId = normalizeResolveId(value.resolveId);
  const rawResolveIds = Array.isArray(value.resolveIds)
    ? value.resolveIds
    : null;

  if (singleResolveId && rawResolveIds === null) {
    return { resolveId: singleResolveId, source };
  }

  if (!singleResolveId && rawResolveIds !== null) {
    if (rawResolveIds.length === 0 || rawResolveIds.length > MAX_BATCH_SIZE) {
      return null;
    }

    const resolveIds = Array.from(
      new Set(
        rawResolveIds
          .map((entry) => normalizeResolveId(entry))
          .filter((entry): entry is string => entry !== null)
      )
    );

    if (resolveIds.length === 0) {
      return null;
    }

    return { resolveIds, source };
  }

  return null;
};

export const getResolverQueueResolveIds = (
  payload: ResolverQueuePayload
): string[] =>
  "resolveId" in payload ? [payload.resolveId] : payload.resolveIds;
