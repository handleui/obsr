import type { CSSProperties } from "react";

// HACK: unsafeCSS injects into Shadow DOM to fine-tune internal layout.
export const COLUMN_CSS = `
  [data-column-number] {
    border-right: 1px solid white;
    padding-left: 12px;
    padding-right: 12px;
  }
  [data-column-content] {
    padding-left: 16px;
    padding-right: 16px;
  }
`;

export const BASE_PIERRE_STYLE = {
  "--diffs-font-family": "var(--font-geist-mono)",
  "--diffs-font-size": "12px",
  "--diffs-line-height": "22px",
  "--diffs-gap-block": "4px",
  "--diffs-fg-number-override": "#000",
  "--diffs-gap-style": "none",
} as CSSProperties;
