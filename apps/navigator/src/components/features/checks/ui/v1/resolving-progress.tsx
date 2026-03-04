import { Sparks } from "iconoir-react";
import { ShimmerText } from "./shimmer-text";

const HealingProgress = () => (
  <div className="flex h-full w-full flex-col bg-white">
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-12 items-center justify-center bg-resolving-bg">
          <Sparks className="size-5" color="var(--color-resolving-fg)" />
        </div>
        <div className="flex flex-col gap-2">
          <ShimmerText
            animation="animate-shimmer-sweep-fast"
            className="text-[16px]"
            color="var(--color-resolving-fg)"
            peakColor="#e4b5ff"
          >
            Resolving in progress
          </ShimmerText>
          <p className="max-w-[300px] text-[13px] text-muted leading-[1.4]">
            The AI is analyzing the error and generating a fix. This typically
            takes 30-60 seconds.
          </p>
        </div>
      </div>
    </div>
  </div>
);

const CompactHealingProgress = () => (
  <div className="sticky top-10 z-10 flex h-10 items-center gap-2 border-subtle border-b bg-white px-4">
    <Sparks className="size-4" color="var(--color-resolving-fg)" />
    <ShimmerText
      animation="animate-shimmer-sweep-fast"
      className="text-[13px]"
      color="var(--color-resolving-fg)"
      peakColor="#e4b5ff"
    >
      Resolving in progress
    </ShimmerText>
    <span className="text-[13px] text-muted">
      &middot; Typically takes 30-60 seconds
    </span>
  </div>
);

export default HealingProgress;
export { CompactHealingProgress };
