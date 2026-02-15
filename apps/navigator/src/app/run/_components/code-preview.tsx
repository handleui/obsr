import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { NavArrowUp, Page } from "iconoir-react";
import { Fragment } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { codeToHast } from "shiki";
import { CollapsedLines } from "./collapsed-lines";
import type { SourceLine } from "./mock-data";

interface CodePreviewProps {
  filename: string;
  lines: SourceLine[];
  collapsedBefore?: number;
  collapsedAfter?: number;
}

const highlightCode = async (code: string, lang: string) => {
  const hast = await codeToHast(code, {
    lang,
    theme: "github-light",
  });

  return toJsxRuntime(hast, {
    Fragment,
    jsx,
    jsxs,
  });
};

const LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  lock: "json",
};

const detectLanguage = (filename: string): string => {
  const ext = filename.split(".").pop()?.toLowerCase();
  return LANG_MAP[ext ?? ""] ?? "text";
};

const FileHeader = ({ filename }: { filename: string }) => (
  <div className="flex h-10 items-center justify-between border-subtle border-b px-4">
    <div className="flex items-center gap-2.5">
      <Page height={12} strokeWidth={1} width={12} />
      <p className="text-[14px] text-black leading-[1.1]">{filename}</p>
    </div>
    <div className="rotate-180">
      <NavArrowUp height={12} strokeWidth={1.2} width={12} />
    </div>
  </div>
);

const LineNumbers = ({ lines }: { lines: SourceLine[] }) => (
  <div className="flex flex-col gap-1.5 px-4 py-3 font-pixel-triangle text-[12px] text-dim leading-[1.1]">
    {lines.map((l) => (
      <p key={l.lineNumber}>{l.lineNumber}</p>
    ))}
  </div>
);

const CodePreview = async ({
  filename,
  lines,
  collapsedBefore,
  collapsedAfter,
}: CodePreviewProps) => {
  const code = lines.map((l) => l.content).join("\n");
  const lang = detectLanguage(filename);
  const highlighted = await highlightCode(code, lang);

  return (
    <div className="flex flex-col">
      <FileHeader filename={filename} />

      <div className="flex flex-col overflow-clip">
        {collapsedBefore != null && <CollapsedLines count={collapsedBefore} />}

        <div className="grid grid-cols-[auto_1fr] border-subtle border-b">
          <LineNumbers lines={lines} />
          <div className="code-preview-content overflow-x-auto py-3 pr-4">
            {highlighted}
          </div>
        </div>

        {collapsedAfter != null && <CollapsedLines count={collapsedAfter} />}
      </div>
    </div>
  );
};

export default CodePreview;
