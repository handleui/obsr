"use client";

import {
  CATEGORY_STYLE,
  ErrorCardDetails,
  ErrorCardPreview,
} from "./error-detail";
import { useRunData } from "./run-data-context";
import type { Category } from "./types";

interface HealPreviewProps {
  errorId: string;
}

const HealPreview = ({ errorId }: HealPreviewProps) => {
  const { errorMap } = useRunData();
  const error = errorMap.get(errorId);
  if (!error) {
    return null;
  }

  const style = CATEGORY_STYLE[error.category as Category];

  return (
    <div className="flex min-h-full w-full shrink-0 flex-col bg-white">
      <div className="sticky top-0 z-10 flex h-10 items-center gap-3 border-subtle border-b bg-white px-4">
        <div
          className={`flex size-4 shrink-0 items-center justify-center overflow-clip p-1 ${style.bg}`}
        >
          <p className={`text-[12px] leading-[1.1] ${style.fg}`}>
            {style.icon}
          </p>
        </div>
        <p className="min-w-0 truncate text-[13px] text-black leading-[1.1]">
          {error.message}
        </p>
      </div>
      <ErrorCardDetails error={error} style={style} />
      <ErrorCardPreview error={error} />
    </div>
  );
};

export default HealPreview;
