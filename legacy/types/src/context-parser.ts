export interface LineContext {
  readonly job: string;
  readonly step: string;
  readonly action?: string;
  readonly isNoise: boolean;
}

export interface ParseLineResult {
  readonly ctx: LineContext;
  readonly cleanLine: string;
  readonly skip: boolean;
}

export interface ContextParser {
  parseLine(line: string): ParseLineResult;
  reset(): void;
}

export type CIProviderID =
  | "github"
  | "act"
  | "gitlab"
  | "circleci"
  | "jenkins"
  | "passthrough";

export interface CIProvider {
  readonly id: CIProviderID;
  readonly name: string;
  detectFromEnv(): boolean;
  createContextParser(): ContextParser;
  readonly isStateful: boolean;
  readonly priority?: number;
  readonly description?: string;
}

export interface CIProviderOptions {
  readonly id: CIProviderID;
  readonly name: string;
  readonly detectFromEnv: () => boolean;
  readonly createContextParser: () => ContextParser;
  readonly isStateful: boolean;
  readonly priority?: number;
  readonly description?: string;
}
