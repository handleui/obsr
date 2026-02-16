"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { ErrorDetailData } from "./mock-data";
import { useRunData } from "./run-data-context";
import { removeFromSet, toggleInSet } from "./set-utils";

interface SelectionContextValue {
  selectedIds: Set<string>;
  select: (id: string, e: React.MouseEvent) => void;
  selectSingle: (id: string) => void;
  deselect: (id: string) => void;
  deselectMany: (ids: Iterable<string>) => void;
  clearSelection: () => void;
  selectedErrors: ErrorDetailData[];
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export const useSelection = () => {
  const ctx = useContext(SelectionContext);
  if (!ctx) {
    throw new Error("useSelection must be used within SelectionProvider");
  }
  return ctx;
};

export const SelectionProvider = ({ children }: { children: ReactNode }) => {
  const { errorMap } = useRunData();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const select = useCallback((id: string, e: React.MouseEvent) => {
    setSelectedIds((prev) => {
      if (e.shiftKey) {
        return toggleInSet(prev, id);
      }
      if (prev.size === 1 && prev.has(id)) {
        return new Set();
      }
      return new Set([id]);
    });
  }, []);

  const deselect = useCallback(
    (id: string) => setSelectedIds((prev) => removeFromSet(prev, [id])),
    []
  );

  const deselectMany = useCallback(
    (ids: Iterable<string>) =>
      setSelectedIds((prev) => removeFromSet(prev, ids)),
    []
  );

  const selectSingle = useCallback(
    (id: string) => setSelectedIds(new Set([id])),
    []
  );

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const selectedErrors = useMemo(
    () =>
      [...selectedIds]
        .map((id) => errorMap.get(id))
        .filter((e): e is ErrorDetailData => e != null),
    [selectedIds, errorMap]
  );

  const value = useMemo(
    () => ({
      selectedIds,
      select,
      selectSingle,
      deselect,
      deselectMany,
      clearSelection,
      selectedErrors,
    }),
    [
      selectedIds,
      select,
      selectSingle,
      deselect,
      deselectMany,
      clearSelection,
      selectedErrors,
    ]
  );

  return <SelectionContext value={value}>{children}</SelectionContext>;
};
