"use client";

import { NavArrowLeft } from "iconoir-react";
import { memo, useCallback, useMemo } from "react";
import { useRunData } from "../../hooks/use-run-data";
import type { ErrorDetailData } from "../../lib/types";
import { ErrorLine } from "./error-line";

interface HealSidebarProps {
  healingErrorId: string;
  activePreviewId: string;
  onSelectPreview: (id: string) => void;
  onBack: () => void;
}

const SidebarErrorLine = memo(
  ({
    error,
    active,
    onSelect,
  }: {
    error: ErrorDetailData & { status: string };
    active: boolean;
    onSelect: (id: string) => void;
  }) => {
    const handleClick = useCallback(
      () => onSelect(error.id),
      [error.id, onSelect]
    );

    return (
      <ErrorLine
        category={error.category}
        compact
        message={error.message}
        onClick={handleClick}
        selected={active}
        status={error.status}
      />
    );
  }
);

const STATUS_ORDER = ["Resolving", "Found", "Fixed"] as const;

const JOB_LABELS: Record<string, string> = {
  test: "Test",
  mig: "Migrations",
  lint: "Lint",
  build: "Build",
  types: "Check Types",
  "check-types": "Check Types",
};

const resolveStatuses = (errors: ErrorDetailData[], healingErrorId: string) =>
  errors.map((e) => ({
    ...e,
    status: e.id === healingErrorId ? "Resolving" : e.status,
  }));

const STATUS_INDEX = new Map<string, number>(
  STATUS_ORDER.map((s, i) => [s, i])
);

const sortByStatus = <T extends { status: string }>(items: T[]) =>
  items.toSorted(
    (a, b) =>
      (STATUS_INDEX.get(a.status) ?? STATUS_ORDER.length) -
      (STATUS_INDEX.get(b.status) ?? STATUS_ORDER.length)
  );

const groupByJob = (errors: ErrorDetailData[], healingErrorId: string) => {
  const resolved = resolveStatuses(errors, healingErrorId);

  const jobMap = new Map<string, typeof resolved>();
  for (const error of resolved) {
    const existing = jobMap.get(error.jobKey) ?? [];
    existing.push(error);
    jobMap.set(error.jobKey, existing);
  }

  return [...jobMap.entries()].map(([jobKey, items]) => ({
    label: JOB_LABELS[jobKey] ?? jobKey,
    items: sortByStatus(items),
  }));
};

const HealSidebar = ({
  healingErrorId,
  activePreviewId,
  onSelectPreview,
  onBack,
}: HealSidebarProps) => {
  const { errors } = useRunData();
  const groups = useMemo(
    () => groupByJob(errors, healingErrorId),
    [healingErrorId, errors]
  );

  return (
    <div className="flex min-h-full w-full shrink-0 flex-col bg-white">
      <button
        className="flex h-10 w-full shrink-0 cursor-pointer items-center gap-1.5 border-subtle border-b px-3 text-[13px] text-muted hover:bg-surface hover:text-black"
        onClick={onBack}
        type="button"
      >
        <NavArrowLeft height={14} strokeWidth={1.5} width={14} />
        Back
      </button>
      <div className="flex w-full min-w-0 flex-col">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="px-3 pt-3 pb-1 text-[11px] text-muted uppercase tracking-wide">
              {group.label}
            </p>
            {group.items.map((error) => (
              <SidebarErrorLine
                active={error.id === activePreviewId}
                error={error}
                key={error.id}
                onSelect={onSelectPreview}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

export default HealSidebar;
