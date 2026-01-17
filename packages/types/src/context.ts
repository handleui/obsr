/**
 * CodeSnippet contains source code context around an error location.
 */
export interface CodeSnippet {
  /** Lines of source code context */
  readonly lines: readonly string[];
  /** First line number in snippet (1-indexed in original file) */
  readonly startLine: number;
  /** Position of error line within lines array (1-indexed, e.g., 1 = lines[0]) */
  readonly errorLine: number;
  /** Language identifier: "go", "typescript", "python", etc. */
  readonly language: string;
}

/**
 * WorkflowContext captures GitHub Actions workflow execution context.
 */
export interface WorkflowContext {
  /** From [workflow/job] prefix in act output */
  readonly job?: string;
  /** Parse from step names */
  readonly step?: string;
  /** Parse from action names */
  readonly action?: string;
}

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
