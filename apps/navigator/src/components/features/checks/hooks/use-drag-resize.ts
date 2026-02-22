"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ResizableGridHandle {
  setWidths: (left: number, right: number, duration?: number) => void;
  readonly widths: { left: number; right: number };
}

const clamp = (min: number, value: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const CONSTRAINTS = {
  left: { min: 0, max: 400, initial: 300 },
  right: { min: 0, max: 1200, initial: 350 },
} as const;

const COLLAPSE_THRESHOLD = 200;
export const EDGE_HITBOX_WIDTH = 64;

export const normalizeProgress = (width: number, threshold: number) =>
  Math.min(1, Math.max(0, width / threshold));

const computeScale = (width: number, threshold: number) =>
  0.95 + 0.05 * normalizeProgress(width, threshold);

const snapToThreshold = (width: number, side: "left" | "right") => {
  const initial = CONSTRAINTS[side].initial;
  if (width < COLLAPSE_THRESHOLD) {
    return 0;
  }
  if (width < initial) {
    return initial;
  }
  return width;
};

const applySidebarStyles = (
  el: HTMLElement | null,
  width: number,
  handleEl: HTMLElement | null,
  side: "left" | "right"
) => {
  if (handleEl) {
    handleEl.style[side] = `${width - 4}px`;
  }
  if (el) {
    const threshold = CONSTRAINTS[side].initial;
    el.style.opacity = String(normalizeProgress(width, threshold));
    el.style.transform = `scale(${computeScale(width, threshold)})`;
  }
};

export const useDragResize = (
  containerRef: React.RefObject<HTMLDivElement | null>,
  initialLeft: number,
  initialRight: number
) => {
  const [activeHandle, setActiveHandle] = useState<"left" | "right" | null>(
    null
  );
  const [hitboxActive, setHitboxActive] = useState({
    left: initialLeft === 0,
    right: initialRight === 0,
  });
  const dragRef = useRef({ startX: 0, startLeftW: 0, startRightW: 0 });
  const widthRef = useRef<{ left: number; right: number }>({
    left: initialLeft,
    right: initialRight,
  });
  const rafRef = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);
  const elementsRef = useRef<{
    leftHandle: HTMLElement | null;
    rightHandle: HTMLElement | null;
    leftInner: HTMLElement | null;
    rightInner: HTMLElement | null;
  }>({
    leftHandle: null,
    rightHandle: null,
    leftInner: null,
    rightInner: null,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const query = <T extends HTMLElement>(selector: string) =>
      el.querySelector<T>(selector);

    const dragHandles = el.querySelectorAll<HTMLElement>(".drag-handle");
    elementsRef.current = {
      leftHandle: dragHandles[0] ?? null,
      rightHandle: dragHandles[1] ?? null,
      leftInner: query("[data-sidebar-inner='left']"),
      rightInner: query("[data-sidebar-inner='right']"),
    };
  }, [containerRef]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      cleanupRef.current?.();
    };
  }, []);

  const applyWidths = useCallback(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const { left: lw, right: rw } = widthRef.current;
    el.style.gridTemplateColumns = `${lw}px 1fr ${rw}px`;
    el.style.setProperty(
      "--left-progress",
      String(normalizeProgress(lw, CONSTRAINTS.left.initial))
    );
    el.style.setProperty(
      "--right-progress",
      String(normalizeProgress(rw, CONSTRAINTS.right.initial))
    );

    el.toggleAttribute("data-left-open", lw > 0);
    el.toggleAttribute("data-right-open", rw > 0);

    const { leftHandle, rightHandle, leftInner, rightInner } =
      elementsRef.current;
    applySidebarStyles(leftInner, lw, leftHandle, "left");
    applySidebarStyles(rightInner, rw, rightHandle, "right");
  }, [containerRef]);

  const updateWidthOnDrag = useCallback(
    (side: "left" | "right", delta: number) => {
      if (side === "left") {
        widthRef.current.left = clamp(
          CONSTRAINTS.left.min,
          dragRef.current.startLeftW + delta,
          CONSTRAINTS.left.max
        );
      } else {
        widthRef.current.right = clamp(
          CONSTRAINTS.right.min,
          dragRef.current.startRightW - delta,
          CONSTRAINTS.right.max
        );
      }
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(applyWidths);
    },
    [applyWidths]
  );

  const animateToWidths = useCallback(
    (targetLeft: number, targetRight: number, duration = 350) => {
      const hitbox = { left: targetLeft === 0, right: targetRight === 0 };

      if (
        widthRef.current.left === targetLeft &&
        widthRef.current.right === targetRight
      ) {
        setHitboxActive(hitbox);
        return;
      }

      const startLeft = widthRef.current.left;
      const startRight = widthRef.current.right;
      const startTime = performance.now();
      const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

      const tick = (now: number) => {
        const progress = Math.min(1, (now - startTime) / duration);
        const ease = easeOutCubic(progress);
        widthRef.current.left = startLeft + (targetLeft - startLeft) * ease;
        widthRef.current.right = startRight + (targetRight - startRight) * ease;
        applyWidths();

        if (progress < 1) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        widthRef.current = { left: targetLeft, right: targetRight };
        applyWidths();
        setHitboxActive(hitbox);
      };

      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    },
    [applyWidths]
  );

  const finalizeDrag = useCallback(() => {
    const targetLeft = snapToThreshold(widthRef.current.left, "left");
    const targetRight = snapToThreshold(widthRef.current.right, "right");
    animateToWidths(targetLeft, targetRight, 200);
  }, [animateToWidths]);

  const startDrag = useCallback(
    (side: "left" | "right", e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      setActiveHandle(side);
      dragRef.current = {
        startX: e.clientX,
        startLeftW: widthRef.current.left,
        startRightW: widthRef.current.right,
      };

      const onMove = (ev: PointerEvent) => {
        updateWidthOnDrag(side, ev.clientX - dragRef.current.startX);
      };

      const teardown = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        cleanupRef.current = null;
      };

      const onUp = () => {
        teardown();
        setActiveHandle(null);
        finalizeDrag();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      cleanupRef.current = teardown;
    },
    [updateWidthOnDrag, finalizeDrag]
  );

  return { activeHandle, hitboxActive, widthRef, startDrag, animateToWidths };
};
