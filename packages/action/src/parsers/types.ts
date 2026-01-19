export interface ParsedError {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  severity?: "error" | "warning";
  ruleId?: string;
  stackTrace?: string;
  suggestions?: string[];
  fixable?: boolean;
}
