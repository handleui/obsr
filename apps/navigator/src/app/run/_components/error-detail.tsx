"use client";

import { Accordion } from "@base-ui-components/react/accordion";
import { Button } from "@detent/ui/button";
import {
  TooltipContent,
  TooltipRoot,
  TooltipTrigger,
} from "@detent/ui/tooltip";
import {
  ArrowDown,
  ArrowUp,
  InfoCircle,
  NavArrowDown,
  Sparks,
  Xmark,
} from "iconoir-react";
import dynamic from "next/dynamic";
import type * as React from "react";
import { useCallback, useEffect, useMemo } from "react";
import type { Category } from "./error-line";
import { useFilters } from "./filter-context";
import { type ErrorDetailData, errorIdToJobKey } from "./mock-data";
import { useRunData } from "./run-data-context";
import { useSelection } from "./selection-context";
import { ShimmerText } from "./shimmer-text";

const FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const DiffPreview = dynamic(() => import("./diff-preview"));
const FaultyLinesPreview = dynamic(() => import("./faulty-lines-preview"));

const CATEGORY_STYLE = {
  Error: { bg: "bg-failure-bg", fg: "text-failure-fg", icon: "!" },
  Warning: { bg: "bg-waiting-bg", fg: "text-waiting-fg", icon: "!" },
  Info: { bg: "bg-info-bg", fg: "text-info-fg", icon: "i" },
} as const;

type CategoryStyle = (typeof CATEGORY_STYLE)[Category];

interface DetailRowProps {
  label: React.ReactNode;
  children: React.ReactNode;
}

const DetailRow = ({ label, children }: DetailRowProps) => (
  <div className="flex items-center justify-between">
    {typeof label === "string" ? <p className="text-muted">{label}</p> : label}
    {children}
  </div>
);

interface ErrorCardProps {
  error: ErrorDetailData;
  onHeal?: () => void;
}

const StatusLabel = () => (
  <div className="flex items-center gap-2">
    <p className="text-muted">Status</p>
    <InfoCircle
      color="var(--color-muted)"
      height={12}
      strokeWidth={1}
      width={12}
    />
  </div>
);

const HealButton = ({
  healing,
  onHeal,
}: {
  healing: boolean;
  onHeal?: () => void;
}) =>
  healing ? (
    <Button className="pointer-events-none bg-healing-fg text-[14px] leading-[1.1] hover:bg-healing-fg">
      <Sparks color="white" />
      <ShimmerText
        animation="animate-shimmer-sweep-fast"
        className="text-[14px] leading-[1.1]"
        color="white"
        peakColor="#ffffff"
      >
        Healing
      </ShimmerText>
    </Button>
  ) : (
    <Button className="text-[14px] leading-[1.1]" onClick={onHeal}>
      <Sparks color="white" />
      Heal
    </Button>
  );

const ErrorCardTrigger = ({
  error,
  style,
  healing,
}: {
  error: ErrorDetailData;
  style: CategoryStyle;
  healing: boolean;
}) => (
  <Accordion.Trigger className="group flex h-10 w-full cursor-pointer items-center gap-3 px-4">
    <div
      className={`flex size-4 shrink-0 items-center justify-center overflow-clip p-1 ${healing ? "bg-healing-bg" : style.bg}`}
    >
      <p
        className={`text-[12px] leading-[1.1] ${healing ? "text-healing-fg" : style.fg}`}
      >
        {style.icon}
      </p>
    </div>
    {healing ? (
      <ShimmerText
        animation="animate-shimmer-sweep-fast"
        className="truncate text-[13px] leading-[1.1]"
        color="var(--color-healing-fg)"
        peakColor="#e4b5ff"
      >
        {error.message}
      </ShimmerText>
    ) : (
      <p className={`truncate text-[13px] ${style.fg} leading-[1.1]`}>
        {error.message}
      </p>
    )}
    <NavArrowDown className="ml-auto size-3 shrink-0 text-black transition-transform group-data-[panel-open]:rotate-180" />
  </Accordion.Trigger>
);

const ErrorCardHeader = ({
  error,
  style,
  onHeal,
}: {
  error: ErrorDetailData;
  style: CategoryStyle;
  onHeal?: () => void;
}) => {
  const healing = error.status === "Healing";

  return (
    <div
      className={`sticky top-10 z-[9] flex h-10 items-center justify-between border-subtle border-b has-[button[aria-expanded]:hover]:border-b-black ${healing ? "bg-[color-mix(in_srgb,var(--color-healing-bg)_40%,white)]" : "bg-white"}`}
    >
      <Accordion.Header className="min-w-0 flex-1">
        <ErrorCardTrigger error={error} healing={healing} style={style} />
      </Accordion.Header>
      <div className="flex shrink-0 items-center">
        <HealButton healing={healing} onHeal={onHeal} />
      </div>
    </div>
  );
};

const ErrorCardDetails = ({
  error,
  style,
}: {
  error: ErrorDetailData;
  style: CategoryStyle;
}) => (
  <div className="flex flex-col gap-6 border-subtle border-b px-4 py-6 text-[14px] leading-[1.1]">
    <DetailRow label="Origin">
      <p className="text-black">{error.origin}</p>
    </DetailRow>
    <DetailRow label="Type">
      <div className={`${style.bg} p-[2px]`}>
        <p className={style.fg}>{error.category}</p>
      </div>
    </DetailRow>
    <DetailRow label="Category">
      <p className="text-black">{error.errorType}</p>
    </DetailRow>
    <DetailRow label={<StatusLabel />}>
      <p className="text-black">{error.status}</p>
    </DetailRow>
  </div>
);

const PreviewSectionHeader = ({ label }: { label: string }) => (
  <div className="flex items-center border-subtle border-b px-4 py-2">
    <p className="text-muted text-xs uppercase">{label}</p>
  </div>
);

const ErrorCardPreview = ({ error }: ErrorCardProps) => {
  if (error.status === "Fixed" && error.diff && error.filename) {
    return (
      <>
        <PreviewSectionHeader label="Modified Files" />
        <DiffPreview diff={error.diff} filename={error.filename} />
      </>
    );
  }

  if (error.sourceLines && error.faultyLineNumbers && error.filename) {
    return (
      <>
        <PreviewSectionHeader label="Source" />
        <FaultyLinesPreview
          category={error.category}
          collapsedAfter={error.collapsedAfter}
          collapsedBefore={error.collapsedBefore}
          faultyLineNumbers={error.faultyLineNumbers}
          filename={error.filename}
          lines={error.sourceLines}
        />
      </>
    );
  }

  return null;
};

const ErrorCard = ({ error, onHeal }: ErrorCardProps) => {
  const style = CATEGORY_STYLE[error.category];

  return (
    <Accordion.Root className="w-full" defaultValue={[0]}>
      <Accordion.Item value={0}>
        <ErrorCardHeader error={error} onHeal={onHeal} style={style} />
        <Accordion.Panel className="overflow-clip">
          <ErrorCardDetails error={error} style={style} />
          <ErrorCardPreview error={error} />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion.Root>
  );
};

const NAV_BTN =
  "flex size-7 cursor-pointer items-center justify-center text-muted outline-none transition-colors hover:text-black disabled:cursor-default disabled:opacity-30 disabled:hover:text-muted";

interface ErrorNavigatorProps {
  hasSelection: boolean;
  totalErrors: number;
  onNavigateUp: () => void;
  onNavigateDown: () => void;
  onClear: () => void;
}

const ErrorNavigator = ({
  hasSelection,
  totalErrors,
  onNavigateUp,
  onNavigateDown,
  onClear,
}: ErrorNavigatorProps) => (
  <div className="flex h-full shrink-0 items-center">
    <div className="flex items-center">
      <TooltipRoot>
        <TooltipTrigger
          className={NAV_BTN}
          disabled={totalErrors === 0}
          onClick={onNavigateUp}
          render={<button type="button" />}
        >
          <ArrowUp height={12} strokeWidth={1.5} width={12} />
        </TooltipTrigger>
        <TooltipContent>Previous error</TooltipContent>
      </TooltipRoot>
      <TooltipRoot>
        <TooltipTrigger
          className={NAV_BTN}
          disabled={totalErrors === 0}
          onClick={onNavigateDown}
          render={<button type="button" />}
        >
          <ArrowDown height={12} strokeWidth={1.5} width={12} />
        </TooltipTrigger>
        <TooltipContent>Next error</TooltipContent>
      </TooltipRoot>
    </div>
    <div className="flex h-full w-10 items-center justify-center border-subtle border-l">
      {hasSelection ? (
        <TooltipRoot>
          <TooltipTrigger
            className="flex size-10 cursor-pointer items-center justify-center text-muted transition-colors hover:text-black"
            onClick={onClear}
            render={<button type="button" />}
          >
            <Xmark height={12} strokeWidth={1.5} width={12} />
          </TooltipTrigger>
          <TooltipContent>Clear selection</TooltipContent>
        </TooltipRoot>
      ) : null}
    </div>
  </div>
);

interface ErrorDetailHeaderProps {
  label: string;
  hasSelection: boolean;
  onClear: () => void;
  showNavigator: boolean;
  totalErrors: number;
  onNavigateUp: () => void;
  onNavigateDown: () => void;
}

const ErrorDetailHeader = ({
  label,
  hasSelection,
  onClear,
  showNavigator,
  totalErrors,
  onNavigateUp,
  onNavigateDown,
}: ErrorDetailHeaderProps) => (
  <div className="sticky top-0 z-10 flex h-10 min-h-10 items-center justify-between border-subtle border-b bg-white pl-4">
    <p className="min-w-0 truncate text-[14px] text-black leading-[1.1]">
      {label}
    </p>
    {showNavigator && (
      <ErrorNavigator
        hasSelection={hasSelection}
        onClear={onClear}
        onNavigateDown={onNavigateDown}
        onNavigateUp={onNavigateUp}
        totalErrors={totalErrors}
      />
    )}
    {!showNavigator && hasSelection && (
      <TooltipRoot>
        <TooltipTrigger
          className="flex size-10 cursor-pointer items-center justify-center text-muted transition-colors hover:text-black"
          onClick={onClear}
          render={<button type="button" />}
        >
          <Xmark height={14} strokeWidth={1.2} width={14} />
        </TooltipTrigger>
        <TooltipContent>Close</TooltipContent>
      </TooltipRoot>
    )}
  </div>
);

const ErrorCardList = ({
  errors,
  onHeal,
}: {
  errors: ErrorDetailData[];
  onHeal?: (id: string) => void;
}) => (
  <div className="flex flex-col">
    {errors.map((error, i) => (
      <div key={error.id}>
        {i > 0 && (
          <div className="-mt-px h-7 border-subtle border-y bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,#e8e8e8_4px,#e8e8e8_5px)]" />
        )}
        <ErrorCard
          error={error}
          onHeal={onHeal ? () => onHeal(error.id) : undefined}
        />
      </div>
    ))}
  </div>
);

const getHeaderLabel = (count: number): string => {
  if (count > 1) {
    return `${count} Errors Selected`;
  }
  if (count === 1) {
    return "Selected Error";
  }
  return "Error Detail";
};

const useVisibleErrors = () => {
  const { jobs: jobRegistry, errors } = useRunData();
  const { jobs, statuses } = useFilters();

  return useMemo(() => {
    const visibleJobs = new Set(
      jobRegistry
        .filter((j) => jobs.has(j.key) && statuses.has(j.status))
        .map((j) => j.key)
    );
    return errors.filter((e) => visibleJobs.has(errorIdToJobKey(e.id)));
  }, [jobs, statuses, jobRegistry, errors]);
};

const useErrorNavigation = (
  navigableErrors: ErrorDetailData[],
  selectedIds: Set<string>,
  selectSingle: (id: string) => void,
  enabled: boolean
) => {
  const currentIndex = useMemo(() => {
    if (selectedIds.size === 0) {
      return -1;
    }
    const firstId = selectedIds.values().next().value;
    return navigableErrors.findIndex((e) => e.id === firstId);
  }, [selectedIds, navigableErrors]);

  const navigateUp = useCallback(() => {
    if (navigableErrors.length === 0) {
      return;
    }
    const newIndex =
      currentIndex <= 0 ? navigableErrors.length - 1 : currentIndex - 1;
    selectSingle(navigableErrors[newIndex].id);
  }, [currentIndex, navigableErrors, selectSingle]);

  const navigateDown = useCallback(() => {
    if (navigableErrors.length === 0) {
      return;
    }
    const newIndex =
      currentIndex === -1 || currentIndex >= navigableErrors.length - 1
        ? 0
        : currentIndex + 1;
    selectSingle(navigableErrors[newIndex].id);
  }, [currentIndex, navigableErrors, selectSingle]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const NAV_KEYS: Record<string, () => void> = {
      ArrowUp: navigateUp,
      ArrowDown: navigateDown,
    };

    const handler = (e: KeyboardEvent) => {
      if (FORM_TAGS.has((e.target as HTMLElement)?.tagName)) {
        return;
      }
      const action = NAV_KEYS[e.key];
      if (!action) {
        return;
      }
      e.preventDefault();
      action();
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, navigateUp, navigateDown]);

  return { navigateUp, navigateDown };
};

interface ErrorDetailProps {
  errorId?: string;
  onHeal?: (id: string) => void;
}

const ErrorDetail = ({ errorId, onHeal }: ErrorDetailProps) => {
  const { errorMap } = useRunData();
  const { selectedIds, selectedErrors, clearSelection, selectSingle } =
    useSelection();

  const navigableErrors = useVisibleErrors();

  const { navigateUp, navigateDown } = useErrorNavigation(
    navigableErrors,
    selectedIds,
    selectSingle,
    !errorId
  );

  const errors = errorId
    ? [errorMap.get(errorId)].filter((e): e is ErrorDetailData => e != null)
    : selectedErrors;

  const headerLabel = errorId
    ? (errors[0]?.message ?? "Error")
    : getHeaderLabel(errors.length);

  return (
    <div className="flex min-h-full w-full shrink-0 flex-col bg-white">
      <ErrorDetailHeader
        hasSelection={errors.length > 0}
        label={headerLabel}
        onClear={clearSelection}
        onNavigateDown={navigateDown}
        onNavigateUp={navigateUp}
        showNavigator={!errorId}
        totalErrors={navigableErrors.length}
      />
      {errors.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <p className="text-[13px] text-muted">
            Every error has a story — pick one
          </p>
        </div>
      ) : (
        <ErrorCardList errors={errors} onHeal={onHeal} />
      )}
    </div>
  );
};

export default ErrorDetail;
export { CATEGORY_STYLE, ErrorCardDetails, ErrorCardPreview };
