"use client";

import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import type { ResizableGridHandle } from "./use-drag-resize";

export const parseHealState = (
  segments: string[],
  errorMap: Map<string, unknown>
) => {
  if (segments.length >= 2 && segments[0] === "resolve") {
    const errorId = segments[1];
    if (errorMap.has(errorId)) {
      return { errorId };
    }
  }
  return null;
};

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

export const useHealSync = (healErrorId: string | undefined) => {
  const [previewErrorId, setPreviewErrorId] = useState<string | undefined>();

  useEffect(() => {
    if (healErrorId) {
      setPreviewErrorId(healErrorId);
    }
  }, [healErrorId]);

  return { previewErrorId, setPreviewErrorId };
};

export const useGridEffects = (
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
