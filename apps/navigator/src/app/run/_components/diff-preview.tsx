"use client";

import { Accordion } from "@base-ui-components/react/accordion";
import { PatchDiff } from "@pierre/diffs/react";
import type * as React from "react";
import { useMemo, useState } from "react";
import { FileAccordionHeader } from "./file-accordion-header";
import { BASE_PIERRE_STYLE, COLUMN_CSS } from "./pierre-css";

const HUNK_CSS = `
  [data-hunk-separator] {
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-geist-mono);
    font-size: 11px;
    color: #999;
    background: white;
    border-top: 1px solid #f0f0f0;
    border-bottom: 1px solid #f0f0f0;
    cursor: pointer;
  }
  [data-hunk-separator]:hover {
    background: #fafafa;
    color: #666;
  }

  [data-separator-content],
  [data-separator-wrapper] {
    border-radius: 0 !important;
  }
`;

const DIFF_CSS = COLUMN_CSS + HUNK_CSS;

const countDiffStats = (
  patch: string
): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }
  return { additions, deletions };
};

interface FileDiff {
  filename: string;
  patch: string;
}

const DIFF_GIT_SPLIT_RE = /(?=^diff --git )/m;
const DIFF_GIT_FILENAME_RE = /^diff --git a\/.+ b\/(.+)$/m;

const splitMultiFileDiff = (diff: string): FileDiff[] => {
  const chunks = diff.split(DIFF_GIT_SPLIT_RE);
  return chunks
    .filter((chunk) => chunk.startsWith("diff --git "))
    .map((chunk) => {
      const match = chunk.match(DIFF_GIT_FILENAME_RE);
      const filename = match?.[1] ?? "unknown";
      return { filename, patch: chunk };
    });
};

const DIFF_STYLE = {
  ...BASE_PIERRE_STYLE,
  "--diffs-addition-color-override": "#34d399",
  "--diffs-deletion-color-override": "var(--color-failure-fg)",
} as React.CSSProperties;

interface DiffPreviewProps {
  diff: string;
  filename: string;
  defaultOpen?: boolean;
}

const SingleFileDiff = ({
  patch,
  overflow,
  onToggleOverflow,
  filename,
  index,
}: {
  patch: string;
  overflow: "wrap" | "scroll";
  onToggleOverflow: () => void;
  filename: string;
  index: number;
}) => {
  const stats = useMemo(() => countDiffStats(patch), [patch]);

  const diffOptions = useMemo(
    () => ({
      diffStyle: "unified" as const,
      theme: "one-light" as const,
      themeType: "light" as const,
      disableFileHeader: true,
      diffIndicators: "bars" as const,
      overflow,
      expandUnchanged: false,
      expansionLineCount: 5,
      hunkSeparators: "line-info" as const,
      unsafeCSS: DIFF_CSS,
    }),
    [overflow]
  );

  return (
    <Accordion.Item value={index}>
      <FileAccordionHeader
        additions={stats.additions}
        deletions={stats.deletions}
        filename={filename}
        onToggleOverflow={onToggleOverflow}
        overflow={overflow}
      />
      <Accordion.Panel className="overflow-clip">
        <div className="border-subtle border-b">
          <PatchDiff options={diffOptions} patch={patch} style={DIFF_STYLE} />
        </div>
      </Accordion.Panel>
    </Accordion.Item>
  );
};

const DiffPreview = ({
  diff,
  filename,
  defaultOpen = true,
}: DiffPreviewProps) => {
  const [overflow, setOverflow] = useState<"wrap" | "scroll">("wrap");
  const toggleOverflow = () =>
    setOverflow((prev) => (prev === "wrap" ? "scroll" : "wrap"));

  const fileDiffs = useMemo(() => splitMultiFileDiff(diff), [diff]);

  const defaultValues =
    defaultOpen && fileDiffs.length <= 2
      ? fileDiffs.map((_, i) => i)
      : undefined;

  if (fileDiffs.length <= 1) {
    return (
      <Accordion.Root
        className="w-full"
        defaultValue={defaultOpen ? [0] : undefined}
      >
        <SingleFileDiff
          filename={filename}
          index={0}
          onToggleOverflow={toggleOverflow}
          overflow={overflow}
          patch={diff}
        />
      </Accordion.Root>
    );
  }

  return (
    <Accordion.Root className="w-full" defaultValue={defaultValues} multiple>
      {fileDiffs.map((file, i) => (
        <SingleFileDiff
          filename={file.filename}
          index={i}
          key={file.filename}
          onToggleOverflow={toggleOverflow}
          overflow={overflow}
          patch={file.patch}
        />
      ))}
    </Accordion.Root>
  );
};

export default DiffPreview;
