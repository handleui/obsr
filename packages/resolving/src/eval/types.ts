/**
 * A test case for evaluating the resolving loop.
 */
export interface ResolvingTestCase {
  /** Unique identifier for this test case */
  id: string;
  /** Description of the error scenario */
  description: string;
  /** The error prompt to send to Claude */
  errorPrompt: string;
  /** Expected outcome metadata */
  expected: {
    /** Should the resolving succeed? */
    shouldSucceed: boolean;
    /** Keywords that should appear in the fix (optional) */
    expectedKeywords?: string[];
    /** Maximum acceptable iterations (optional) */
    maxIterations?: number;
    /** Maximum acceptable cost in USD (optional) */
    maxCostUSD?: number;
  };
  /** Tags for filtering test cases */
  tags?: string[];
}

/**
 * Result from running a resolving eval.
 */
export interface ResolvingEvalResult {
  /** Whether the resolving succeeded */
  success: boolean;
  /** Number of iterations taken */
  iterations: number;
  /** Total tool calls made */
  toolCalls: number;
  /** Cost in USD */
  costUSD: number;
  /** Duration in milliseconds */
  duration: number;
  /** Final message from Claude */
  finalMessage: string;
}
