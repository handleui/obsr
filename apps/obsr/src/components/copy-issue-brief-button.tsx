"use client";

import { useEffect, useRef, useState } from "react";

type CopyStatus = "idle" | "copied" | "failed";

export const CopyIssueBriefButton = ({ brief }: { brief: string }) => {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const resetTimerRef = useRef<number | null>(null);
  let statusMessage = "";
  if (status === "copied") {
    statusMessage = "Issue brief copied.";
  }
  if (status === "failed") {
    statusMessage = "Issue brief copy failed.";
  }

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const scheduleReset = () => {
    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current);
    }

    resetTimerRef.current = window.setTimeout(() => {
      setStatus("idle");
      resetTimerRef.current = null;
    }, 1200);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(brief);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }

    scheduleReset();
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        className="inline-flex h-10 items-center justify-center rounded-full border border-line bg-panel px-4 font-medium text-ink text-sm hover:border-accent hover:bg-accent-soft"
        onClick={handleCopy}
        type="button"
      >
        Copy issue brief
      </button>
      <span aria-live="polite" className="sr-only">
        {statusMessage}
      </span>
      {statusMessage ? (
        <span aria-hidden className="text-muted text-xs">
          {status === "copied" ? "Copied." : "Copy failed."}
        </span>
      ) : null}
    </div>
  );
};
