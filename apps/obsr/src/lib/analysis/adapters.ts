import type { AnalysisCreateInput, InputKind } from "@/lib/contracts";

export interface NormalizedInputPayload {
  inputKind: InputKind;
  rawLog: string;
}

export interface InputAdapter<TInput> {
  kind: InputKind | FutureAutoFetchKind;
  collect: (input: TInput) => NormalizedInputPayload;
}

export const futureAutoFetchKinds = ["github-actions", "circleci"] as const;

export type FutureAutoFetchKind = (typeof futureAutoFetchKinds)[number];

const normalizeLog = (rawLog: string) => {
  return rawLog.replace(/\r\n/g, "\n");
};

export const pasteAdapter: InputAdapter<AnalysisCreateInput> = {
  kind: "paste",
  collect: (input) => ({
    inputKind: "paste",
    rawLog: normalizeLog(input.rawLog),
  }),
};
