export type Category = "Error" | "Warning" | "Info";

export interface SourceLine {
  lineNumber: number;
  content: string;
}

export interface ErrorDetailData {
  id: string;
  jobKey: string;
  category: Category;
  location: string;
  message: string;
  origin: string;
  errorType: string;
  status: string;
  diff?: string;
  filename?: string;
  collapsedBefore?: number;
  collapsedAfter?: number;
  sourceLines?: SourceLine[];
  faultyLineNumbers?: number[];
}

export interface JobMeta {
  key: string;
  status: string;
}

export interface RunData {
  org: string;
  project: string;
  pr: string;
  title: string;
  author: string;
  branch: { source: string; target: string };
  files: number;
  additions: number;
  deletions: number;
  description: string;
  jobs: JobMeta[];
  errors: ErrorDetailData[];
}
