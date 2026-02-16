"use client";

import type * as React from "react";
import { ShimmerText } from "./shimmer-text";

const CATEGORY_CONFIG = {
  Error: {
    color: "text-failure-fg",
    label: "Error",
    selectedStyle: "border-failure-fg bg-failure-bg/40",
  },
  Warning: {
    color: "text-waiting-fg",
    label: "Warn",
    selectedStyle: "border-waiting-fg bg-waiting-bg/50",
  },
  Info: {
    color: "text-info-fg",
    label: "Info",
    selectedStyle: "border-info-fg bg-info-bg/50",
  },
} as const;

type Category = keyof typeof CATEGORY_CONFIG;

interface ErrorLineProps {
  category?: Category;
  compact?: boolean;
  selected?: boolean;
  location?: string;
  message?: string;
  status?: string;
  onClick?: (e: React.MouseEvent) => void;
}

const getLineStyle = (
  selected: boolean,
  healing: boolean,
  selectedStyle: string
) => {
  if (selected && healing) {
    return "border-healing-fg bg-healing-bg/40";
  }
  if (selected) {
    return selectedStyle;
  }
  if (healing) {
    return "border-l-transparent";
  }
  return "border-l-transparent hover:bg-surface";
};

const extractFilename = (path?: string) => {
  if (!path) {
    return "Global";
  }
  return path.split("/").at(-1) ?? path;
};

const HEALING_SHIMMER = {
  animation: "animate-shimmer-sweep-fast" as const,
  color: "var(--color-healing-fg)",
  peakColor: "#e4b5ff",
};

const HealingCells = ({
  label,
  filename,
  message,
  status,
}: {
  label: string;
  filename: string;
  message: string;
  status: string;
}) => (
  <>
    <ShimmerText {...HEALING_SHIMMER} className="text-[12px]">
      {label}
    </ShimmerText>
    <ShimmerText {...HEALING_SHIMMER} className="truncate text-[13px]">
      {filename}
    </ShimmerText>
    <ShimmerText {...HEALING_SHIMMER} className="truncate text-[13px]">
      {message}
    </ShimmerText>
    <ShimmerText {...HEALING_SHIMMER} className="text-right text-[12px]">
      {status}
    </ShimmerText>
  </>
);

const DefaultCells = ({
  label,
  filename,
  message,
  status,
  color,
}: {
  label: string;
  filename: string;
  message: string;
  status: string;
  color: string;
}) => (
  <>
    <p className={`text-[12px] ${color}`}>{label}</p>
    <p className="truncate text-[13px] text-muted">{filename}</p>
    <p className="truncate text-[13px] text-black">{message}</p>
    <p className="text-right text-[12px] text-muted">{status}</p>
  </>
);

const CompactCells = ({
  message,
  status,
  color,
  healing,
}: {
  message: string;
  status: string;
  color: string;
  healing: boolean;
}) => (
  <>
    {healing ? (
      <>
        <ShimmerText {...HEALING_SHIMMER} className="truncate text-[13px]">
          {message}
        </ShimmerText>
        <ShimmerText {...HEALING_SHIMMER} className="text-right text-[12px]">
          {status}
        </ShimmerText>
      </>
    ) : (
      <>
        <p className="truncate text-[13px] text-black">{message}</p>
        <p className={`text-right text-[12px] ${color}`}>{status}</p>
      </>
    )}
  </>
);

const ErrorLine = ({
  category = "Error",
  compact = false,
  selected = false,
  location,
  message = "Unable to load dependency @detent/autofix",
  status = "Found",
  onClick,
}: ErrorLineProps) => {
  const { color, label, selectedStyle } = CATEGORY_CONFIG[category];
  const filename = extractFilename(location);
  const healing = status === "Healing";

  if (compact) {
    return (
      <button
        className={`grid h-[28px] w-full cursor-pointer grid-cols-[1fr_52px] gap-2 border-l-2 px-3 py-1.5 text-left ${getLineStyle(selected, healing, selectedStyle)}`}
        onClick={onClick}
        type="button"
      >
        <CompactCells
          color={color}
          healing={healing}
          message={message}
          status={status}
        />
      </button>
    );
  }

  return (
    <button
      className={`grid h-[28px] w-full cursor-pointer grid-cols-[60px_140px_1fr_52px] gap-3 border-l-2 px-4 py-1.5 text-left ${getLineStyle(selected, healing, selectedStyle)}`}
      onClick={onClick}
      type="button"
    >
      {healing ? (
        <HealingCells
          filename={filename}
          label={label}
          message={message}
          status={status}
        />
      ) : (
        <DefaultCells
          color={color}
          filename={filename}
          label={label}
          message={message}
          status={status}
        />
      )}
    </button>
  );
};

export { ErrorLine };
export type { Category, ErrorLineProps };
