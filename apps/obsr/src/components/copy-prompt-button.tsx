"use client";

import { useEffect, useRef, useState } from "react";

type CopyStatus = "idle" | "copied" | "failed";

export const CopyPromptButton = ({ prompt }: { prompt: string }) => {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const resetTimerRef = useRef<number | null>(null);
  let label = "Copy prompt";
  if (status === "failed") {
    label = "Copy failed";
  }
  if (status === "copied") {
    label = "Copied prompt";
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
      await navigator.clipboard.writeText(prompt);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }

    scheduleReset();
  };

  return (
    <button
      className="inline-flex h-10 items-center justify-center rounded-full border border-line bg-panel px-4 font-medium text-ink text-sm hover:border-accent hover:bg-accent-soft"
      onClick={handleCopy}
      type="button"
    >
      {label}
    </button>
  );
};
