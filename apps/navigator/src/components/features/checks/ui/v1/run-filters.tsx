"use client";

import { Popover } from "@base-ui-components/react/popover";
import { Select } from "@base-ui-components/react/select";
import {
  TooltipContent,
  TooltipRoot,
  TooltipTrigger,
} from "@detent/ui/tooltip";
import {
  Check,
  Copy,
  Eye,
  GitCommit,
  MinusCircle,
  NavArrowDown,
  Sparks,
  Xmark,
} from "iconoir-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useFilters } from "../../hooks/use-filters";

const RUN_ID = "87887654";
const COPY_FEEDBACK_MS = 1500;

interface CommitOption {
  value: string;
  label: string;
}

interface IconOption {
  value: string;
  label: string;
  icon: ReactNode;
}

const COMMITS: CommitOption[] = [
  { value: "latest", label: "Latest Commit" },
  { value: "abc1234", label: "abc1234 — initial push" },
  { value: "def5678", label: "def5678 — fix tests" },
  { value: "a1b2c3d", label: "a1b2c3d — add migrations" },
];

const JOBS: IconOption[] = [
  {
    value: "lint",
    label: "Lint",
    icon: <div className="size-1.5 bg-waiting-accent" />,
  },
  {
    value: "test",
    label: "Test",
    icon: <Xmark color="var(--color-failure-fg)" height={12} width={12} />,
  },
  {
    value: "check-types",
    label: "Check Types",
    icon: <Check color="var(--color-success-fg)" height={12} width={12} />,
  },
  {
    value: "migrations",
    label: "Migrations",
    icon: <Sparks color="#9747FF" height={12} width={12} />,
  },
  {
    value: "build",
    label: "Build",
    icon: <MinusCircle color="var(--color-muted)" height={12} width={12} />,
  },
];

const STATUSES: IconOption[] = [
  {
    value: "successful",
    label: "Successful",
    icon: <Check color="var(--color-success-fg)" height={12} width={12} />,
  },
  {
    value: "healed",
    label: "Healed",
    icon: <Sparks color="var(--color-success-fg)" height={12} width={12} />,
  },
  {
    value: "failed",
    label: "Failed",
    icon: <Xmark color="var(--color-failure-fg)" height={12} width={12} />,
  },
  {
    value: "resolving",
    label: "Resolving",
    icon: <Sparks color="#9747FF" height={12} width={12} />,
  },
  {
    value: "waiting",
    label: "Waiting",
    icon: <div className="size-1.5 bg-waiting-accent" />,
  },
  {
    value: "skipped",
    label: "Skipped",
    icon: <MinusCircle color="var(--color-muted)" height={12} width={12} />,
  },
];

interface StatusSection {
  label: string;
  items: IconOption[];
}

const buildStatusSections = (
  definitions: { label: string; values: string[] }[]
): StatusSection[] =>
  definitions.map(({ label, values }) => ({
    label,
    items: values
      .map((v) => STATUSES.find((s) => s.value === v))
      .filter((s): s is IconOption => s != null),
  }));

const STATUS_SECTIONS: StatusSection[] = buildStatusSections([
  { label: "Passing", values: ["successful", "healed"] },
  { label: "Attention", values: ["failed", "resolving", "waiting"] },
  { label: "Other", values: ["skipped"] },
]);

const Chevron = () => <NavArrowDown height={10} strokeWidth={1.5} width={10} />;

const resolveFilterLabel = (
  selected: Set<string>,
  total: number,
  singular: string,
  plural: string,
  allItems: { value: string; label: string }[]
): string => {
  if (selected.size === total) {
    return `All ${plural}`;
  }
  if (selected.size === 0) {
    return `No ${plural}`;
  }
  if (selected.size === 1) {
    return (
      allItems.find((i) => selected.has(i.value))?.label ?? `1 ${singular}`
    );
  }
  return `${selected.size} ${plural}`;
};

const ClearButton = ({ onClear }: { onClear: () => void }) => (
  <TooltipRoot>
    <TooltipTrigger
      className="cursor-pointer text-dim transition-colors hover:text-black"
      onClick={onClear}
      render={<span />}
    >
      <Xmark height={10} strokeWidth={2} width={10} />
    </TooltipTrigger>
    <TooltipContent>Clear filter</TooltipContent>
  </TooltipRoot>
);

interface ToggleRowProps {
  checked: boolean;
  icon: ReactNode;
  label: string;
  onSelect: (e: React.MouseEvent) => void;
  showCheck?: boolean;
}

const ToggleRow = ({
  checked,
  icon,
  label,
  onSelect,
  showCheck,
}: ToggleRowProps) => (
  <button
    className={`flex w-full cursor-pointer select-none items-center gap-2.5 px-3 py-1.5 font-geist text-[13px] transition-colors hover:bg-surface ${checked ? "text-black" : "text-muted"}`}
    onClick={onSelect}
    type="button"
  >
    <span
      className={`flex size-3 shrink-0 items-center justify-center ${checked ? "" : "opacity-25"}`}
    >
      {icon}
    </span>
    <span className="flex-1 text-left">{label}</span>
    {showCheck && checked && (
      <Check
        className="shrink-0 text-black"
        height={10}
        strokeWidth={2}
        width={10}
      />
    )}
  </button>
);

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <p className="px-3 pt-2.5 pb-1 font-geist text-[10px] text-dim uppercase tracking-[0.08em]">
    {children}
  </p>
);

const PopupDivider = () => <div className="my-1 h-px bg-subtle" />;

const CommitFilter = () => {
  const [value, setValue] = useState("latest");
  const selected = COMMITS.find((c) => c.value === value) ?? COMMITS[0];
  const isDirty = value !== "latest";

  return (
    <Select.Root
      onValueChange={(v) => {
        if (v !== null) {
          setValue(v);
        }
      }}
      value={value}
    >
      <div className="flex items-center gap-1.5">
        <Select.Trigger
          className={`flex cursor-pointer items-center gap-2 transition-colors hover:text-black ${isDirty ? "text-black" : ""}`}
        >
          <GitCommit height={12} width={12} />
          <span className="font-geist text-[13px]">{selected.label}</span>
          {!isDirty && (
            <Select.Icon>
              <Chevron />
            </Select.Icon>
          )}
        </Select.Trigger>
        {isDirty && <ClearButton onClear={() => setValue("latest")} />}
      </div>
      <Select.Portal>
        <Select.Positioner
          align="end"
          alignItemWithTrigger={false}
          side="bottom"
          sideOffset={4}
        >
          <Select.Popup className="min-w-[200px] border border-subtle bg-white py-1">
            <Select.List>
              {COMMITS.map((c) => (
                <Select.Item
                  className="flex cursor-pointer items-center px-3 py-1.5 font-geist text-[13px] text-black data-[highlighted]:bg-surface"
                  key={c.value}
                  value={c.value}
                >
                  <Select.ItemText>{c.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
};

const JobsFilter = () => {
  const {
    jobs: selected,
    toggleJob: toggle,
    soloJob: solo,
    resetJobs,
  } = useFilters();

  const isDirty = selected.size !== JOBS.length;
  const label = resolveFilterLabel(selected, JOBS.length, "Job", "Jobs", JOBS);

  return (
    <Popover.Root>
      <div className="flex items-center gap-1.5">
        <Popover.Trigger
          className={`flex cursor-pointer items-center gap-2 transition-colors hover:text-black ${isDirty ? "text-black" : ""}`}
        >
          <Eye height={12} width={12} />
          <span className="font-geist text-[13px]">{label}</span>
          {!isDirty && <Chevron />}
        </Popover.Trigger>
        {isDirty && <ClearButton onClear={resetJobs} />}
      </div>
      <Popover.Portal>
        <Popover.Positioner align="end" side="bottom" sideOffset={4}>
          <Popover.Popup className="min-w-[180px] border border-subtle bg-white py-1 outline-none">
            {JOBS.map((job) => (
              <ToggleRow
                checked={selected.has(job.value)}
                icon={job.icon}
                key={job.value}
                label={job.label}
                onSelect={(e) =>
                  e.shiftKey ? toggle(job.value) : solo(job.value)
                }
                showCheck={isDirty}
              />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

const StatusFilter = () => {
  const {
    statuses: selected,
    toggleStatus: toggle,
    soloStatus: solo,
    resetStatuses,
  } = useFilters();

  const isDirty = selected.size !== STATUSES.length;
  const label = resolveFilterLabel(
    selected,
    STATUSES.length,
    "Status",
    "Statuses",
    STATUSES
  );
  const singleSelected =
    isDirty && selected.size === 1
      ? STATUSES.find((s) => selected.has(s.value))
      : null;

  const triggerIcon = singleSelected?.icon ?? (
    <div className="size-2 rounded-full bg-current" />
  );

  return (
    <Popover.Root>
      <div className="flex items-center gap-1.5">
        <Popover.Trigger
          className={`flex cursor-pointer items-center gap-2 transition-colors hover:text-black ${isDirty ? "text-black" : ""}`}
        >
          <span className="flex size-3 items-center justify-center">
            {triggerIcon}
          </span>
          <span className="font-geist text-[13px]">{label}</span>
          {!isDirty && <Chevron />}
        </Popover.Trigger>
        {isDirty && <ClearButton onClear={resetStatuses} />}
      </div>
      <Popover.Portal>
        <Popover.Positioner align="end" side="bottom" sideOffset={4}>
          <Popover.Popup className="min-w-[200px] border border-subtle bg-white py-1 outline-none">
            {STATUS_SECTIONS.map((section, i) => (
              <div key={section.label}>
                {i > 0 && <PopupDivider />}
                <SectionLabel>{section.label}</SectionLabel>
                {section.items.map((status) => (
                  <ToggleRow
                    checked={selected.has(status.value)}
                    icon={status.icon}
                    key={status.value}
                    label={status.label}
                    onSelect={(e) =>
                      e.shiftKey ? toggle(status.value) : solo(status.value)
                    }
                    showCheck={isDirty}
                  />
                ))}
              </div>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

const CopyRunId = () => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(RUN_ID);
    setCopied(true);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  return (
    <div className="flex items-center gap-2 text-muted">
      <p className="font-geist text-[13px]">Run ID</p>
      <TooltipRoot>
        <TooltipTrigger
          className="cursor-pointer transition-colors hover:text-black"
          onClick={handleCopy}
          render={<span />}
        >
          {copied ? (
            <Check height={16} strokeWidth={1.2} width={16} />
          ) : (
            <Copy height={16} strokeWidth={1.2} width={16} />
          )}
        </TooltipTrigger>
        <TooltipContent>Copy Run ID</TooltipContent>
      </TooltipRoot>
      <p className="font-geist text-[13px]">{RUN_ID}</p>
    </div>
  );
};

const RunFilters = () => (
  <div className="flex w-full items-center justify-between py-6">
    <CopyRunId />
    <div className="flex items-center gap-4 text-muted">
      <CommitFilter />
      <JobsFilter />
      <StatusFilter />
    </div>
  </div>
);

export { RunFilters };
