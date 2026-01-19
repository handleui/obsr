import type { ParsedError } from "../types";

interface VitestLocation {
  line: number;
  column: number;
}

interface VitestAssertionResult {
  ancestorTitles?: string[];
  fullName?: string;
  status: "passed" | "failed" | "pending" | "todo" | "skipped";
  title: string;
  duration?: number;
  failureMessages?: string[];
  location?: VitestLocation;
  meta?: Record<string, unknown>;
}

interface VitestTestResult {
  assertionResults: VitestAssertionResult[];
  startTime?: number;
  endTime?: number;
  status: "passed" | "failed" | "pending";
  message?: string;
  name: string;
}

interface VitestJsonOutput {
  numTotalTestSuites?: number;
  numPassedTestSuites?: number;
  numFailedTestSuites?: number;
  numPendingTestSuites?: number;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  startTime?: number;
  success: boolean;
  testResults: VitestTestResult[];
  coverageMap?: Record<string, unknown>;
}

const isFailedAssertion = (assertion: VitestAssertionResult): boolean =>
  assertion.status === "failed";

const hasFailureMessages = (assertion: VitestAssertionResult): boolean =>
  assertion.failureMessages !== undefined &&
  assertion.failureMessages.length > 0;

const formatTestTitle = (assertion: VitestAssertionResult): string => {
  if (assertion.fullName) {
    return assertion.fullName.trim();
  }
  const ancestors = assertion.ancestorTitles?.filter(Boolean) ?? [];
  return [...ancestors, assertion.title].join(" > ");
};

const extractStackTrace = (failureMessages: string[]): string | undefined => {
  const combined = failureMessages.join("\n");
  return combined.length > 0 ? combined : undefined;
};

const parseAssertion = (
  filePath: string,
  assertion: VitestAssertionResult
): ParsedError => {
  const testTitle = formatTestTitle(assertion);
  const firstMessage = assertion.failureMessages?.[0] ?? "Test failed";

  return {
    message: `${testTitle}: ${firstMessage.split("\n")[0]}`,
    filePath,
    line: assertion.location?.line,
    column: assertion.location?.column,
    severity: "error",
    stackTrace: assertion.failureMessages
      ? extractStackTrace(assertion.failureMessages)
      : undefined,
  };
};

export const parseVitest = (content: string): ParsedError[] => {
  let data: VitestJsonOutput;
  try {
    data = JSON.parse(content) as VitestJsonOutput;
  } catch {
    return [];
  }

  if (!Array.isArray(data.testResults) || data.testResults.length === 0) {
    return [];
  }

  return data.testResults.flatMap((result) =>
    result.assertionResults
      .filter(isFailedAssertion)
      .filter(hasFailureMessages)
      .map((assertion) => parseAssertion(result.name, assertion))
  );
};
