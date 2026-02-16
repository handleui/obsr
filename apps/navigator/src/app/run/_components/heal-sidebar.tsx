"use client";

import { NavArrowLeft } from "iconoir-react";
import { useMemo } from "react";
import { ErrorLine } from "./error-line";
import type { ErrorDetailData } from "./mock-data";
import { useRunData } from "./run-data-context";

interface HealSidebarProps {
  healingErrorId: string;
  activePreviewId: string;
  onSelectPreview: (id: string) => void;
  onBack: () => void;
}

const STATUS_ORDER = ["Healing", "Found", "Fixed"] as const;

const JOB_LABELS: Record<string, string> = {
  test: "Test",
  mig: "Migrations",
  lint: "Lint",
  build: "Build",
  types: "Check Types",
  "check-types": "Check Types",
};

type ResolvedError = ErrorDetailData & { status: string };

const resolveHealingStatus = (
  errors: ErrorDetailData[],
  healingErrorId: string
): ResolvedError[] =>
  errors.map((e) => ({
    ...e,
    status: e.id === healingErrorId ? "Healing" : e.status,
  }));

const collectByJobPrefix = (errors: ResolvedError[]) => {
  const jobMap = new Map<string, ResolvedError[]>();
  for (const error of errors) {
    const prefix = error.id.split("-")[0];
    const existing = jobMap.get(prefix) ?? [];
    existing.push(error);
    jobMap.set(prefix, existing);
  }
  return jobMap;
};

const sortByStatusOrder = (items: ResolvedError[]) =>
  [...items].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status as (typeof STATUS_ORDER)[number]) -
      STATUS_ORDER.indexOf(b.status as (typeof STATUS_ORDER)[number])
  );

const groupByJob = (errors: ErrorDetailData[], healingErrorId: string) => {
  const resolved = resolveHealingStatus(errors, healingErrorId);
  const jobMap = collectByJobPrefix(resolved);

  return [...jobMap.entries()].map(([prefix, items]) => ({
    label: JOB_LABELS[prefix] ?? prefix,
    items: sortByStatusOrder(items),
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
              <ErrorLine
                category={error.category}
                compact
                key={error.id}
                message={error.message}
                onClick={() => onSelectPreview(error.id)}
                selected={error.id === activePreviewId}
                status={error.status}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

export default HealSidebar;
