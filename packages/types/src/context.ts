import type { CICodeSnippet, CIWorkflowContext } from "./diagnostic.js";

/**
 * @deprecated Use CICodeSnippet from diagnostic.ts instead.
 */
export type CodeSnippet = CICodeSnippet;

/**
 * @deprecated Use CIWorkflowContext from diagnostic.ts instead.
 */
export type WorkflowContext = CIWorkflowContext;

/**
 * Clone a WorkflowContext for safe mutation.
 * Creates a shallow defensive copy to prevent mutation of the original.
 *
 * @param ctx - The context to clone (may be undefined)
 * @returns A new WorkflowContext with the same values, or undefined if input was undefined
 */
export const cloneWorkflowContext = (
  ctx: WorkflowContext | undefined
): WorkflowContext | undefined => {
  if (!ctx) {
    return undefined;
  }
  return { ...ctx };
};
