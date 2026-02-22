"use client";

import { Accordion } from "@base-ui-components/react/accordion";
import { File } from "@pierre/diffs/react";
import { useMemo, useState } from "react";
import { BASE_PIERRE_STYLE, COLUMN_CSS } from "../../lib/pierre-css";
import type { Category, SourceLine } from "../../lib/types";
import { CollapsedLines } from "./collapsed-lines";
import { FileAccordionHeader } from "./file-accordion-header";

const CATEGORY_COLORS: Record<
  Category,
  { numBg: string; numFg: string; contentBg: string }
> = {
  Error: {
    numBg: "var(--color-failure-bg)",
    numFg: "var(--color-failure-fg)",
    contentBg: "color-mix(in srgb, var(--color-failure-bg) 60%, transparent)",
  },
  Warning: {
    numBg: "var(--color-waiting-bg)",
    numFg: "var(--color-waiting-fg)",
    contentBg: "color-mix(in srgb, var(--color-waiting-bg) 60%, transparent)",
  },
  Info: {
    numBg: "var(--color-info-bg)",
    numFg: "var(--color-info-fg)",
    contentBg: "color-mix(in srgb, var(--color-info-bg) 60%, transparent)",
  },
};

const buildFaultyCSS = (pierreLines: number[], category: Category) => {
  if (pierreLines.length === 0) {
    return "";
  }
  const { numBg, numFg, contentBg } = CATEGORY_COLORS[category];
  const selector = pierreLines.map((n) => `[data-line="${n}"]`).join(",\n  ");
  return `
  ${selector} {
    & [data-column-number] { background-color: ${numBg}; color: ${numFg}; }
    & [data-column-content] { background-color: ${contentBg}; }
  }`;
};

interface FaultyLinesPreviewProps {
  filename: string;
  lines: SourceLine[];
  faultyLineNumbers: number[];
  category: Category;
  collapsedBefore?: number;
  collapsedAfter?: number;
  defaultOpen?: boolean;
}

const FaultyLinesPreview = ({
  filename,
  lines,
  faultyLineNumbers,
  category,
  collapsedBefore,
  collapsedAfter,
  defaultOpen = true,
}: FaultyLinesPreviewProps) => {
  const [overflow, setOverflow] = useState<"wrap" | "scroll">("wrap");
  const toggleOverflow = () =>
    setOverflow((prev) => (prev === "wrap" ? "scroll" : "wrap"));

  const fileContents = useMemo(
    () => ({
      name: filename,
      contents: lines.map((l) => l.content).join("\n"),
    }),
    [filename, lines]
  );

  const pierreFaultyLines = useMemo(() => {
    const lineNumMap = new Map(lines.map((l, i) => [l.lineNumber, i + 1]));
    return faultyLineNumbers
      .map((n) => lineNumMap.get(n))
      .filter((n): n is number => n != null);
  }, [lines, faultyLineNumbers]);

  const options = useMemo(
    () => ({
      theme: "one-light" as const,
      themeType: "light" as const,
      disableFileHeader: true,
      overflow,
      unsafeCSS: COLUMN_CSS + buildFaultyCSS(pierreFaultyLines, category),
    }),
    [overflow, pierreFaultyLines, category]
  );

  return (
    <Accordion.Root
      className="w-full"
      defaultValue={defaultOpen ? [0] : undefined}
    >
      <Accordion.Item value={0}>
        <FileAccordionHeader
          filename={filename}
          onToggleOverflow={toggleOverflow}
          overflow={overflow}
        />
        <Accordion.Panel className="overflow-clip">
          <div className="flex flex-col overflow-clip">
            {collapsedBefore != null && (
              <CollapsedLines count={collapsedBefore} />
            )}

            <div className="border-subtle border-b">
              <File
                file={fileContents}
                options={options}
                style={BASE_PIERRE_STYLE}
              />
            </div>

            {collapsedAfter != null && (
              <CollapsedLines count={collapsedAfter} />
            )}
          </div>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion.Root>
  );
};

export default FaultyLinesPreview;
