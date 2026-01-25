import type { Diagnostic } from "../types.js";

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
): Diagnostic => {
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

export const parseVitest = (content: string): Diagnostic[] => {
  let data: VitestJsonOutput;
  try {
    data = JSON.parse(content) as VitestJsonOutput;
  } catch {
    return [];
  }

  if (!Array.isArray(data.testResults) || data.testResults.length === 0) {
    return [];
  }

  // Direct iteration avoids intermediate arrays from flatMap/filter/filter/map
  const diagnostics: Diagnostic[] = [];
  for (const result of data.testResults) {
    for (const assertion of result.assertionResults) {
      if (isFailedAssertion(assertion) && hasFailureMessages(assertion)) {
        diagnostics.push(parseAssertion(result.name, assertion));
      }
    }
  }
  return diagnostics;
};
