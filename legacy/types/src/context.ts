import type { CICodeSnippet, CIWorkflowContext } from "./diagnostic.js";

export type CodeSnippet = CICodeSnippet;
export type WorkflowContext = CIWorkflowContext;

export const cloneWorkflowContext = (
  ctx: WorkflowContext | undefined
): WorkflowContext | undefined => {
  if (!ctx) {
    return undefined;
  }

  return { ...ctx };
};
