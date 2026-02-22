"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ErrorDetailData } from "../lib/types";

const FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

// HACK: Keep a mutable ref to avoid re-registering the keydown listener
// every time navigateUp/navigateDown callbacks change.
const useStableRef = <T>(value: T) => {
  const ref = useRef(value);
  ref.current = value;
  return ref;
};

const findSelectedIndex = (
  selectedIds: Set<string>,
  errors: ErrorDetailData[]
) => {
  if (selectedIds.size === 0) {
    return -1;
  }
  const firstId = selectedIds.values().next().value;
  return errors.findIndex((e) => e.id === firstId);
};

export const useArrowKeyNavigation = (
  enabled: boolean,
  navigateUp: () => void,
  navigateDown: () => void
) => {
  const upRef = useStableRef(navigateUp);
  const downRef = useStableRef(navigateDown);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handler = (e: KeyboardEvent) => {
      if (FORM_TAGS.has((e.target as HTMLElement)?.tagName)) {
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        upRef.current();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        downRef.current();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, upRef, downRef]);
};

export const useErrorNavigation = (
  navigableErrors: ErrorDetailData[],
  selectedIds: Set<string>,
  selectSingle: (id: string) => void,
  enabled: boolean
) => {
  const currentIndex = useMemo(
    () => findSelectedIndex(selectedIds, navigableErrors),
    [selectedIds, navigableErrors]
  );

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

  useArrowKeyNavigation(enabled, navigateUp, navigateDown);

  return { navigateUp, navigateDown };
};
