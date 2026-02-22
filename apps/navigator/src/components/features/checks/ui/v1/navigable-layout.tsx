"use client";

import type * as React from "react";
import { lazy, Suspense, useCallback, useMemo, useRef } from "react";
import type { ResizableGridHandle } from "../../hooks/use-drag-resize";
import {
  parseHealState,
  useGridEffects,
  useHealSync,
} from "../../hooks/use-grid-effects";
import { useNavigation } from "../../hooks/use-navigation";
import { useRunData } from "../../hooks/use-run-data";
import { useSelection } from "../../hooks/use-selection";
import ErrorDetail from "./error-detail";
import { CompactHealingProgress } from "./healing-progress";
import ResizableGrid from "./resizable-grid";
import RunOverview from "./run-overview";

const HealPreview = lazy(() => import("./heal-preview"));
const HealSidebar = lazy(() => import("./heal-sidebar"));

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
