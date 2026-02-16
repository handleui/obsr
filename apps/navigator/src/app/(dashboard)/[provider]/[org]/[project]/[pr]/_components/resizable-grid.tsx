"use client";

import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export interface ResizableGridHandle {
  setWidths: (left: number, right: number, duration?: number) => void;
  readonly widths: { left: number; right: number };
}

interface ResizableGridProps {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  initialLeft?: number;
  initialRight?: number;
  onLeftCollapsedChange?: (collapsed: boolean) => void;
}

const clamp = (min: number, value: number, max: number) =>
  Math.min(max, Math.max(min, value));

const CONSTRAINTS = {
  left: { min: 0, max: 400, initial: 300 },
  right: { min: 0, max: 1200, initial: 350 },
} as const;

const COLLAPSE_THRESHOLD = 200;
const EDGE_HITBOX_WIDTH = 64;

const normalizeProgress = (width: number, threshold: number) =>
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

interface DragHandleProps {
  side: "left" | "right";
  isActive: boolean;
  position: number;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

const DragHandle = ({
  side,
  isActive,
  position,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
}: DragHandleProps) => (
  <div
    className="drag-handle"
    data-active={isActive ? "" : undefined}
    onPointerDown={onPointerDown}
    onPointerEnter={onPointerEnter}
    onPointerLeave={onPointerLeave}
    style={{ [side]: `${position - 4}px` }}
  />
);

interface SidebarPanelProps {
  side: "left" | "right";
  width: number;
  children: ReactNode;
}

const SidebarPanel = ({ side, width, children }: SidebarPanelProps) => {
  const isLeft = side === "left";
  const constraint = CONSTRAINTS[side];
  return (
    <aside className="relative overflow-hidden" style={{ minWidth: 0 }}>
      <div
        className={`scrollbar-hidden absolute top-0 ${isLeft ? "left-0" : "right-0 flex flex-col"} h-full overflow-y-auto`}
        data-sidebar-inner={side}
        style={{
          width: "100%",
          minWidth: `${constraint.initial}px`,
          opacity: normalizeProgress(width, constraint.initial),
          transform: `scale(${computeScale(width, constraint.initial)})`,
          transformOrigin: `${side} center`,
        }}
      >
        {children}
      </div>
    </aside>
  );
};

interface EdgeHitboxProps {
  side: "left" | "right";
  isActive: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}

const EdgeHitbox = ({ side, isActive, onPointerDown }: EdgeHitboxProps) => {
  const isLeft = side === "left";
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        top: 0,
        [isLeft ? "left" : "right"]: 0,
        width: `${EDGE_HITBOX_WIDTH}px`,
        height: "100%",
        zIndex: 30,
        cursor: "grab",
        pointerEvents: isActive ? "auto" : ("none" as const),
        userSelect: "none",
        touchAction: "none",
      }}
    />
  );
};

const useDragResize = (
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

    elementsRef.current = {
      leftHandle: query(".drag-handle:first-of-type"),
      rightHandle: query(".drag-handle:last-of-type"),
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

const ResizableGrid = ({
  left,
  center,
  right,
  initialLeft,
  initialRight,
  onLeftCollapsedChange,
  ref,
}: ResizableGridProps & { ref?: Ref<ResizableGridHandle> }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredHandle, setHoveredHandle] = useState<"left" | "right" | null>(
    null
  );
  const { activeHandle, hitboxActive, widthRef, startDrag, animateToWidths } =
    useDragResize(
      containerRef,
      initialLeft ?? CONSTRAINTS.left.initial,
      initialRight ?? CONSTRAINTS.right.initial
    );

  useEffect(() => {
    onLeftCollapsedChange?.(hitboxActive.left);
  }, [hitboxActive.left, onLeftCollapsedChange]);

  useImperativeHandle(
    ref,
    () => ({
      setWidths: animateToWidths,
      get widths() {
        return widthRef.current;
      },
    }),
    [animateToWidths, widthRef]
  );

  return (
    <div
      className="resizable-grid relative grid flex-1 overflow-hidden"
      data-active-handle={activeHandle ?? undefined}
      data-hovered-handle={
        activeHandle ? undefined : (hoveredHandle ?? undefined)
      }
      data-left-open={widthRef.current.left > 0 ? "" : undefined}
      data-right-open={widthRef.current.right > 0 ? "" : undefined}
      ref={containerRef}
      style={
        {
          gridTemplateColumns: `${widthRef.current.left}px 1fr ${widthRef.current.right}px`,
          "--left-progress": normalizeProgress(
            widthRef.current.left,
            CONSTRAINTS.left.initial
          ),
          "--right-progress": normalizeProgress(
            widthRef.current.right,
            CONSTRAINTS.right.initial
          ),
          cursor: activeHandle ? "grabbing" : undefined,
        } as React.CSSProperties
      }
    >
      <SidebarPanel side="left" width={widthRef.current.left}>
        {left}
      </SidebarPanel>

      <main className="scrollbar-hidden overflow-y-auto">{center}</main>

      <SidebarPanel side="right" width={widthRef.current.right}>
        {right}
      </SidebarPanel>

      <DragHandle
        isActive={activeHandle === "left"}
        onPointerDown={(e) => startDrag("left", e)}
        onPointerEnter={() => !activeHandle && setHoveredHandle("left")}
        onPointerLeave={() => !activeHandle && setHoveredHandle(null)}
        position={widthRef.current.left}
        side="left"
      />
      <DragHandle
        isActive={activeHandle === "right"}
        onPointerDown={(e) => startDrag("right", e)}
        onPointerEnter={() => !activeHandle && setHoveredHandle("right")}
        onPointerLeave={() => !activeHandle && setHoveredHandle(null)}
        position={widthRef.current.right}
        side="right"
      />

      <EdgeHitbox
        isActive={hitboxActive.left}
        onPointerDown={(e) => startDrag("left", e)}
        side="left"
      />
      <EdgeHitbox
        isActive={hitboxActive.right}
        onPointerDown={(e) => startDrag("right", e)}
        side="right"
      />
    </div>
  );
};

export default ResizableGrid;
