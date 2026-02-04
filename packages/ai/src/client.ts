export const normalizeModelId = (model: string): string => {
  if (model.includes("/")) {
    return model;
  }
  if (model.startsWith("gpt-")) {
    return `openai/${model}`;
  }
  if (model.startsWith("claude-")) {
    return `anthropic/${model}`;
  }
  return model;
};
