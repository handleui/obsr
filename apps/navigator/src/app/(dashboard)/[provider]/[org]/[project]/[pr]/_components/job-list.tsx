"use client";

import { Accordion } from "@base-ui-components/react/accordion";
import {
  TooltipContent,
  TooltipRoot,
  TooltipTrigger,
} from "@detent/ui/tooltip";
import {
  ArrowUpRight,
  Check,
  MinusCircle,
  NavArrowDown,
  Redo,
  Sparks,
  Xmark,
} from "iconoir-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo } from "react";
import { ErrorLine } from "./error-line";
import { useFilters } from "./filter-context";
import { useRunData } from "./run-data-context";
import { useSelection } from "./selection-context";
import { ShimmerText } from "./shimmer-text";
import type { StatusVariant } from "./status-badge";
import { StatusBadge } from "./status-badge";
import type { Category, ErrorDetailData } from "./types";

const EMPTY_ERRORS: ErrorDetailData[] = [];
const HEAL_COLOR = "#9747FF";
const SUCCESS_COLOR = "var(--color-success-fg)";

const VARIANT_LABELS: Record<StatusVariant, string> = {
  failure: "errors",
  waiting: "warnings",
  info: "notices",
};

const AccordionChevron = () => (
  <NavArrowDown
    className="transition-transform group-data-[panel-open]:rotate-180"
    height={12}
    strokeWidth={1.2}
    width={12}
  />
);

const EmptyPanel = ({ icon, label }: { icon: ReactNode; label: ReactNode }) => (
  <div className="flex w-full items-center justify-center border-subtle border-b bg-white px-4 py-6">
    <div className="flex items-center gap-2 text-[13px] text-muted">
      {icon}
      {label}
    </div>
  </div>
);

const IssueTableHeader = () => (
  <div className="grid w-full grid-cols-[60px_140px_1fr_52px] items-end gap-3 border-subtle border-b px-4 pt-2 pb-2 text-[12px] text-muted">
    <p>Type</p>
    <p>Location</p>
    <p>Description</p>
    <p className="text-right">Status</p>
  </div>
);

interface IssueItem {
  id: string;
  category: Category;
  location?: string;
  message?: string;
  status?: string;
}

interface IssueTableProps {
  items: IssueItem[];
}

const IssueRow = memo(
  ({
    item,
    selected,
    onSelect,
  }: {
    item: IssueItem;
    selected: boolean;
    onSelect: (id: string, e: React.MouseEvent) => void;
  }) => {
    const handleClick = useCallback(
      (e: React.MouseEvent) => onSelect(item.id, e),
      [item.id, onSelect]
    );

    return (
      <ErrorLine
        category={item.category}
        location={item.location}
        message={item.message}
        onClick={handleClick}
        selected={selected}
        status={item.status}
      />
    );
  }
);

const IssueTable = ({ items }: IssueTableProps) => {
  const { selectedIds, select } = useSelection();

  return (
    <div className="flex w-full flex-col items-start border-subtle border-b bg-white">
      <IssueTableHeader />
      <div className="flex w-full flex-col items-start py-3">
        {items.map((item) => (
          <IssueRow
            item={item}
            key={item.id}
            onSelect={select}
            selected={selectedIds.has(item.id)}
          />
        ))}
      </div>
    </div>
  );
};

const categoryToVariant: Record<Category, StatusVariant> = {
  Error: "failure",
  Warning: "waiting",
  Info: "info",
};

const issueCounts = (items: IssueItem[]) => {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
  }
  return (["Error", "Warning", "Info"] as const)
    .filter((cat) => (counts[cat] ?? 0) > 0)
    .map((cat) => ({ count: counts[cat], variant: categoryToVariant[cat] }));
};

interface JobTriggerProps {
  icon: ReactNode;
  label: string;
  subtitle?: ReactNode;
  trailing?: ReactNode;
}

const JobTrigger = ({ icon, label, subtitle, trailing }: JobTriggerProps) => (
  <Accordion.Header>
    <Accordion.Trigger className="group flex w-full cursor-pointer items-center justify-between border-subtle border-b px-4 py-3 hover:border-b-black">
      <div className="flex items-center gap-3">
        {icon}
        <p className="text-[14px] text-black leading-[1.1]">{label}</p>
        {subtitle}
      </div>
      <div className="flex items-center gap-2">
        {trailing}
        <AccordionChevron />
      </div>
    </Accordion.Trigger>
  </Accordion.Header>
);

const WaitingDot = ({ size }: { size: "lg" | "sm" }) => (
  <div
    className={`relative overflow-clip ${size === "lg" ? "size-4" : "size-3"}`}
  >
    <div
      className={`absolute bg-waiting-accent ${size === "lg" ? "top-[5px] left-[5px] size-[6px]" : "top-[4px] left-[4px] size-[4px]"}`}
    />
  </div>
);

const HEAL_ICON = <Sparks color={HEAL_COLOR} height={12} width={12} />;

const STATUS_ICONS: Record<string, ReactNode> = {
  waiting: <WaitingDot size="lg" />,
  failed: (
    <Xmark
      color="var(--color-failure-fg)"
      height={16}
      strokeWidth={1.2}
      width={16}
    />
  ),
  successful: (
    <Check color={SUCCESS_COLOR} height={16} strokeWidth={1.2} width={16} />
  ),
  healing: <Sparks color={HEAL_COLOR} height={16} width={16} />,
  skipped: <MinusCircle height={16} width={16} />,
};

const JOB_LABELS: Record<string, string> = {
  lint: "Lint",
  test: "Test",
  "check-types": "Check Types",
  migrations: "Migrations",
  build: "Build",
};

const resolveJobSubtitle = (status: string, issueCount: number): ReactNode => {
  if (status === "waiting") {
    return (
      <ShimmerText
        animation="animate-shimmer-sweep-fast"
        className="text-[13px] leading-[1.1]"
        color="var(--color-dim)"
        peakColor="var(--color-waiting-accent)"
      >
        Waiting for job to complete
      </ShimmerText>
    );
  }
  if (status === "healing") {
    return (
      <ShimmerText
        animation="animate-shimmer-sweep-fast"
        className="text-[13px] leading-[1.1]"
        color="var(--color-dim)"
        peakColor={HEAL_COLOR}
      >
        Healing Errors
      </ShimmerText>
    );
  }
  if (status === "failed" && issueCount > 0) {
    return (
      <p className="text-[13px] text-dim leading-[1.1]">
        Failed with {issueCount} issues
      </p>
    );
  }
  if (status === "successful") {
    return (
      <p className="text-[13px] text-dim leading-[1.1]">Successful in 20s</p>
    );
  }
  return undefined;
};

const WaitingPanel = () => (
  <EmptyPanel
    icon={<WaitingDot size="sm" />}
    label={
      <TooltipRoot>
        <TooltipTrigger
          className="flex cursor-pointer items-center gap-1.5"
          render={
            // biome-ignore lint/a11y/useAnchorContent: content provided by TooltipTrigger children
            <a
              href="https://github.com"
              rel="noopener noreferrer"
              target="_blank"
            />
          }
        >
          <ShimmerText
            animation="animate-shimmer-sweep-fast"
            color="var(--color-muted)"
            peakColor="var(--color-waiting-accent)"
          >
            Waiting for results
          </ShimmerText>
          <ArrowUpRight
            className="shrink-0 text-muted"
            height={11}
            strokeWidth={1.5}
            width={11}
          />
        </TooltipTrigger>
        <TooltipContent>View on GitHub</TooltipContent>
      </TooltipRoot>
    }
  />
);

const SuccessPanel = () => (
  <EmptyPanel
    icon={
      <Check color={SUCCESS_COLOR} height={14} strokeWidth={1.2} width={14} />
    }
    label="All checks passed"
  />
);

const SkippedPanel = () => (
  <EmptyPanel icon={<MinusCircle height={14} width={14} />} label="Skipped" />
);

const NoIssuesPanel = () => (
  <EmptyPanel icon={<MinusCircle height={14} width={14} />} label="No issues" />
);

const resolveJobPanel = (
  status: string,
  issues: ErrorDetailData[]
): ReactNode => {
  if (status === "waiting") {
    return <WaitingPanel />;
  }
  if (status === "successful") {
    return <SuccessPanel />;
  }
  if (status === "skipped") {
    return <SkippedPanel />;
  }
  if (issues.length > 0) {
    return <IssueTable items={issues} />;
  }
  return <NoIssuesPanel />;
};

const GenericJob = memo(
  ({
    jobKey,
    status,
    issues,
  }: {
    jobKey: string;
    status: string;
    issues: ErrorDetailData[];
  }) => {
    const label = JOB_LABELS[jobKey] ?? jobKey;
    const icon = STATUS_ICONS[status] ?? <MinusCircle height={16} width={16} />;
    const subtitle = resolveJobSubtitle(status, issues.length);
    const trailing =
      status === "failed" || status === "healing" ? HEAL_ICON : undefined;

    return (
      <Accordion.Item className="w-full" value={jobKey}>
        <JobTrigger
          icon={icon}
          label={label}
          subtitle={subtitle}
          trailing={trailing}
        />
        <Accordion.Panel>{resolveJobPanel(status, issues)}</Accordion.Panel>
      </Accordion.Item>
    );
  }
);

const JobListHeader = () => {
  const { errors } = useRunData();
  const totalCounts = useMemo(() => issueCounts(errors), [errors]);

  return (
    <div className="flex h-[40px] w-full items-center justify-between border-subtle border-b px-4">
      <div className="flex items-center gap-3">
        <p className="text-[14px] text-black leading-[1.1]">CI</p>
        <div className="size-1 bg-dim" />
        <div className="flex items-center gap-2">
          {totalCounts.map(({ count, variant }) => (
            <TooltipRoot key={variant}>
              <TooltipTrigger className="cursor-pointer">
                <StatusBadge count={count} variant={variant} />
              </TooltipTrigger>
              <TooltipContent>
                {count} {VARIANT_LABELS[variant]}
              </TooltipContent>
            </TooltipRoot>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 text-muted">
        <TooltipRoot>
          <TooltipTrigger className="flex cursor-pointer">
            <Redo height={16} width={16} />
          </TooltipTrigger>
          <TooltipContent>Re-run all jobs</TooltipContent>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger className="flex cursor-pointer">
            <Sparks color={HEAL_COLOR} height={12} width={12} />
          </TooltipTrigger>
          <TooltipContent>Heal failing jobs</TooltipContent>
        </TooltipRoot>
      </div>
    </div>
  );
};

const JobList = () => {
  const { jobs: jobRegistry, errors } = useRunData();
  const { jobs, statuses } = useFilters();
  const { deselectMany } = useSelection();

  const visible = useMemo(
    () =>
      new Set(
        jobRegistry
          .filter((j) => jobs.has(j.key) && statuses.has(j.status))
          .map((j) => j.key)
      ),
    [jobs, statuses, jobRegistry]
  );

  const errorsByJob = useMemo(
    () => Map.groupBy(errors, (e) => e.jobKey),
    [errors]
  );

  const hiddenErrorIds = useMemo(
    () => errors.filter((e) => !visible.has(e.jobKey)).map((e) => e.id),
    [errors, visible]
  );

  const hiddenKey = hiddenErrorIds.join("\0");
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — use serialised key instead of array ref to avoid spurious deselectMany calls
  useEffect(() => {
    deselectMany(hiddenErrorIds);
  }, [hiddenKey, deselectMany]);

  const defaultOpen = useMemo(
    () =>
      jobRegistry
        .filter(
          (j) =>
            (j.status === "failed" || j.status === "healing") &&
            visible.has(j.key)
        )
        .map((j) => j.key),
    [jobRegistry, visible]
  );

  return (
    <div className="flex w-full flex-col items-start overflow-clip border-subtle border-x border-t bg-white">
      <JobListHeader />
      <div className="flex w-full flex-col items-start bg-surface">
        {visible.size === 0 ? (
          <div className="flex w-full items-center justify-center border-subtle border-b px-4 py-6">
            <p className="text-[13px] text-muted">
              No jobs match the selected filters
            </p>
          </div>
        ) : (
          <Accordion.Root
            className="w-full"
            defaultValue={defaultOpen}
            multiple
          >
            {jobRegistry
              .filter((j) => visible.has(j.key))
              .map((j) => (
                <GenericJob
                  issues={errorsByJob.get(j.key) ?? EMPTY_ERRORS}
                  jobKey={j.key}
                  key={j.key}
                  status={j.status}
                />
              ))}
          </Accordion.Root>
        )}
      </div>
    </div>
  );
};

export { JobList };
