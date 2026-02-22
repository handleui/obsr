import { Collapse } from "iconoir-react";

export const CollapsedLines = ({ count }: { count: number }) => (
  <div className="flex h-10 items-center border-subtle border-b bg-surface px-4">
    <div className="flex items-center gap-2.5">
      <Collapse
        color="var(--color-dim)"
        height={12}
        strokeWidth={1}
        width={12}
      />
      <p className="text-[12px] text-dim leading-[1.1]">{count} other lines</p>
    </div>
  </div>
);
