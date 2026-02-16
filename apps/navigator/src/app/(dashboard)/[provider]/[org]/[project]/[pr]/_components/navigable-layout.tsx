"use client";

import type * as React from "react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ErrorDetail from "./error-detail";
import { CompactHealingProgress } from "./healing-progress";
import { useNavigation } from "./navigation/navigation-context";
import ResizableGrid, { type ResizableGridHandle } from "./resizable-grid";
import { useRunData } from "./run-data-context";
import RunOverview from "./run-overview";
import { useSelection } from "./selection-context";

const HealPreview = lazy(() => import("./heal-preview"));
const HealSidebar = lazy(() => import("./heal-sidebar"));

const parseHealState = (segments: string[], errorMap: Map<string, unknown>) => {
  if (segments.length >= 2 && segments[0] === "heal") {
    const errorId = segments[1];
    if (errorMap.has(errorId)) {
      return { errorId };
    }
  }
  return null;
};

const LeftPanelHeader = () => {
  const { run } = useRunData();
  return (
    <div className="sticky top-0 z-10 border-subtle border-b bg-white">
      <div className="flex h-10 items-center px-4">
        <p className="text-[14px] text-black leading-[1.1] tracking-[-0.42px]">
          {run.org}/{run.project}
        </p>
      </div>
    </div>
  );
};

const CenterHeader = ({
  leftCollapsed,
  breadcrumb,
  children,
}: {
  leftCollapsed: boolean;
  breadcrumb?: React.ReactNode;
  children?: React.ReactNode;
}) => (
  <div className="sticky top-0 z-10 flex h-10 items-center border-subtle border-b bg-white">
    {breadcrumb && (
      <div
        className={leftCollapsed ? "" : "pointer-events-none"}
        style={{ opacity: "calc(1 - var(--left-progress, 0))" }}
      >
        {breadcrumb}
      </div>
    )}
    <div className="ml-auto flex items-center">{children}</div>
  </div>
);

const useExpandLeftOnHeal = (
  gridRef: React.RefObject<ResizableGridHandle | null>,
  isHealing: boolean
) => {
  useEffect(() => {
    const grid = gridRef.current;
    if (!(grid && isHealing) || grid.widths.left !== 0) {
      return;
    }
    grid.setWidths(350, grid.widths.right);
  }, [isHealing, gridRef]);
};

const useExpandRightOnSelection = (
  gridRef: React.RefObject<ResizableGridHandle | null>,
  selectedIds: ReadonlySet<string>,
  isHealing: boolean
) => {
  useEffect(() => {
    const grid = gridRef.current;
    if (
      !grid ||
      isHealing ||
      selectedIds.size === 0 ||
      grid.widths.right !== 0
    ) {
      return;
    }
    grid.setWidths(grid.widths.left, 440);
  }, [selectedIds, isHealing, gridRef]);
};

const useCollapseRightOnHeal = (
  gridRef: React.RefObject<ResizableGridHandle | null>,
  isHealing: boolean
) => {
  const wasHealingRef = useRef(isHealing);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return;
    }

    const wasHealing = wasHealingRef.current;
    wasHealingRef.current = isHealing;

    if (isHealing && !wasHealing) {
      grid.setWidths(350, 0);
    } else if (!isHealing && wasHealing) {
      grid.setWidths(0, 440);
    }
  }, [isHealing, gridRef]);
};

const useHealSync = (healErrorId: string | undefined) => {
  const [previewErrorId, setPreviewErrorId] = useState<string | undefined>();

  useEffect(() => {
    if (healErrorId) {
      setPreviewErrorId(healErrorId);
    }
  }, [healErrorId]);

  return { previewErrorId, setPreviewErrorId };
};

const useGridEffects = (
  gridRef: React.RefObject<ResizableGridHandle | null>,
  isHealing: boolean,
  selectedIds: ReadonlySet<string>
) => {
  const [leftCollapsed, setLeftCollapsed] = useState(!isHealing);

  useEffect(() => {
    if (isHealing) {
      setLeftCollapsed(false);
    }
  }, [isHealing]);

  useExpandLeftOnHeal(gridRef, isHealing);
  useExpandRightOnSelection(gridRef, selectedIds, isHealing);
  useCollapseRightOnHeal(gridRef, isHealing);

  return { leftCollapsed, setLeftCollapsed };
};

const NavigableLayout = () => {
  const { errorMap, run } = useRunData();
  const { segments, navigate, pop } = useNavigation();
  const gridRef = useRef<ResizableGridHandle>(null);
  const { selectedIds } = useSelection();

  const healState = useMemo(
    () => parseHealState(segments, errorMap),
    [segments, errorMap]
  );
  const isHealing = !!healState;

  const { previewErrorId, setPreviewErrorId } = useHealSync(healState?.errorId);
  const { leftCollapsed, setLeftCollapsed } = useGridEffects(
    gridRef,
    isHealing,
    selectedIds
  );

  const handleHeal = useCallback(
    (errorId: string) => navigate(`heal/${errorId}`),
    [navigate]
  );

  const breadcrumb = useMemo(
    () => (
      <div className="flex h-10 items-center px-4">
        <p className="text-[14px] text-black leading-[1.1] tracking-[-0.42px]">
          {run.org}/{run.project}
        </p>
      </div>
    ),
    [run.org, run.project]
  );

  const activeErrorId = previewErrorId ?? healState?.errorId ?? "";

  return (
    <ResizableGrid
      center={
        <>
          <CenterHeader breadcrumb={breadcrumb} leftCollapsed={leftCollapsed} />
          {healState ? (
            <>
              <CompactHealingProgress />
              <div className="mx-auto max-w-[800px]">
                <Suspense>
                  <HealPreview errorId={activeErrorId} />
                </Suspense>
              </div>
            </>
          ) : (
            <div className="mx-auto max-w-[800px]">
              <RunOverview />
            </div>
          )}
        </>
      }
      initialLeft={isHealing ? 350 : 0}
      initialRight={isHealing ? 0 : 440}
      left={
        <>
          <LeftPanelHeader />
          {healState && (
            <Suspense>
              <HealSidebar
                activePreviewId={activeErrorId}
                healingErrorId={healState.errorId}
                onBack={pop}
                onSelectPreview={setPreviewErrorId}
              />
            </Suspense>
          )}
        </>
      }
      onLeftCollapsedChange={setLeftCollapsed}
      ref={gridRef}
      right={healState ? null : <ErrorDetail onHeal={handleHeal} />}
    />
  );
};

export default NavigableLayout;
