export const ResolverQueueSources = {
  Create: "create" as const,
  Trigger: "trigger" as const,
};

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

const isResolverQueueSource = (value: unknown): value is ResolverQueueSource =>
  value === ResolverQueueSources.Create ||
  value === ResolverQueueSources.Trigger;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const parseResolverQueuePayload = (
  value: unknown
): ResolverQueuePayload | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Record<string, unknown>;
  if (!isResolverQueueSource(payload.source)) {
    return null;
  }

  if (typeof payload.resolveId === "string" && payload.resolveId.trim()) {
    return {
      resolveId: payload.resolveId,
      source: payload.source,
    };
  }

  if (isStringArray(payload.resolveIds) && payload.resolveIds.length > 0) {
    return {
      resolveIds: payload.resolveIds.filter((resolveId) => resolveId.trim()),
      source: payload.source,
    };
  }

  return null;
};

export const getResolverQueueResolveIds = (
  payload: ResolverQueuePayload
): string[] => {
  if ("resolveId" in payload) {
    return [payload.resolveId];
  }

  return payload.resolveIds;
};
