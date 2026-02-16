"use client";

import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorDetail from "./error-detail";
import HealPreview from "./heal-preview";
import HealSidebar from "./heal-sidebar";
import { CompactHealingProgress } from "./healing-progress";
import { useNavigation } from "./navigation/navigation-context";
import ProviderSelect from "./provider-select";
import ResizableGrid, { type ResizableGridHandle } from "./resizable-grid";
import { useRunData } from "./run-data-context";
import RunOverview from "./run-overview";
import { useSelection } from "./selection-context";
import SidebarHeader from "./sidebar-header";

const parseHealState = (segments: string[], errorMap: Map<string, unknown>) => {
  if (segments.length >= 2 && segments[0] === "heal") {
    const errorId = segments[1];
    if (errorMap.has(errorId)) {
      return { errorId };
    }
  }
  return null;
};

const LeftPanelHeader = () => (
  <div className="sticky top-0 z-10 border-subtle border-b bg-white">
    <SidebarHeader />
  </div>
);

const CenterHeader = ({
  leftCollapsed,
  children,
}: {
  leftCollapsed: boolean;
  children?: React.ReactNode;
}) => (
  <div className="sticky top-0 z-10 flex h-10 items-center border-subtle border-b bg-white">
    <div
      className={leftCollapsed ? "" : "pointer-events-none"}
      style={{ opacity: "calc(1 - var(--left-progress, 0))" }}
    >
      <SidebarHeader showTrailingDivider />
    </div>
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

const NavigableLayout = () => {
  const { errorMap } = useRunData();
  const { segments, navigate, pop } = useNavigation();
  const gridRef = useRef<ResizableGridHandle>(null);
  const healState = useMemo(
    () => parseHealState(segments, errorMap),
    [segments, errorMap]
  );
  const [previewErrorId, setPreviewErrorId] = useState<string | undefined>();

  useEffect(() => {
    if (healState?.errorId) {
      setPreviewErrorId(healState.errorId);
    }
  }, [healState?.errorId]);

  const isHealing = !!healState;
  const [leftCollapsed, setLeftCollapsed] = useState(!isHealing);

  useEffect(() => {
    if (isHealing) {
      setLeftCollapsed(false);
    }
  }, [isHealing]);

  const { selectedIds } = useSelection();

  useExpandLeftOnHeal(gridRef, isHealing);
  useExpandRightOnSelection(gridRef, selectedIds, isHealing);
  useCollapseRightOnHeal(gridRef, isHealing);

  const handleHeal = useCallback(
    (errorId: string) => navigate(`heal/${errorId}`),
    [navigate]
  );

  return (
    <ResizableGrid
      center={
        healState ? (
          <>
            <CenterHeader leftCollapsed={leftCollapsed} />
            <CompactHealingProgress />
            <div className="mx-auto max-w-[800px]">
              <HealPreview errorId={previewErrorId ?? healState.errorId} />
            </div>
          </>
        ) : (
          <>
            <CenterHeader leftCollapsed={leftCollapsed}>
              <ProviderSelect />
            </CenterHeader>
            <div className="mx-auto max-w-[800px]">
              <RunOverview />
            </div>
          </>
        )
      }
      initialLeft={isHealing ? 350 : 0}
      initialRight={isHealing ? 0 : 440}
      left={
        healState ? (
          <>
            <LeftPanelHeader />
            <HealSidebar
              activePreviewId={previewErrorId ?? healState.errorId}
              healingErrorId={healState.errorId}
              onBack={pop}
              onSelectPreview={setPreviewErrorId}
            />
          </>
        ) : (
          <LeftPanelHeader />
        )
      }
      onLeftCollapsedChange={setLeftCollapsed}
      ref={gridRef}
      right={healState ? null : <ErrorDetail onHeal={handleHeal} />}
    />
  );
};

export default NavigableLayout;
