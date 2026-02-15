"use client";

import { Accordion } from "@base-ui-components/react/accordion";
import { AlignLeft, NavArrowDown, Page, WrapText } from "iconoir-react";

interface FileAccordionHeaderProps {
  filename: string;
  overflow: "wrap" | "scroll";
  onToggleOverflow: () => void;
  additions?: number;
  deletions?: number;
}

const shortenPath = (path: string): { prefix: string; name: string } => {
  const parts = path.split("/");
  if (parts.length <= 1) {
    return { prefix: "", name: path };
  }
  const name = parts.at(-1) ?? path;
  const parents = parts.slice(0, -1);
  const tail = parents.slice(-2).join("/");
  const prefix = parents.length > 2 ? `…/${tail}` : tail;
  return { prefix, name };
};

const FileAccordionHeader = ({
  filename,
  overflow,
  onToggleOverflow,
  additions,
  deletions,
}: FileAccordionHeaderProps) => {
  const { prefix, name } = shortenPath(filename);

  return (
    <Accordion.Header className="sticky top-20 z-[8] bg-white">
      <Accordion.Trigger className="group flex h-10 w-full cursor-pointer items-center justify-between border-subtle border-b px-4 hover:border-b-black">
        <span className="flex min-w-0 items-center gap-2.5">
          <Page className="shrink-0" height={12} strokeWidth={1} width={12} />
          <span className="truncate text-[14px] leading-[1.1]">
            {prefix && <span className="text-muted">{prefix}/</span>}
            <span className="text-black">{name}</span>
          </span>
          {(additions != null || deletions != null) && (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] leading-[1.1]">
              {additions != null && additions > 0 && (
                <span className="text-[#34d399]">+{additions}</span>
              )}
              {deletions != null && deletions > 0 && (
                <span className="text-failure-fg">-{deletions}</span>
              )}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {/* biome-ignore lint/a11y/useSemanticElements: nested inside Accordion.Trigger (button), cannot nest another button */}
          <span
            className="flex size-6 cursor-pointer items-center justify-center text-muted transition-colors hover:text-black"
            onClick={(e) => {
              e.stopPropagation();
              onToggleOverflow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                onToggleOverflow();
              }
            }}
            role="button"
            tabIndex={0}
          >
            {overflow === "wrap" ? (
              <WrapText height={12} strokeWidth={1.2} width={12} />
            ) : (
              <AlignLeft height={12} strokeWidth={1.2} width={12} />
            )}
          </span>
          <NavArrowDown className="size-3 text-black transition-transform group-data-[panel-open]:rotate-180" />
        </span>
      </Accordion.Trigger>
    </Accordion.Header>
  );
};

export { FileAccordionHeader };
export type { FileAccordionHeaderProps };
