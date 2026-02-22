"use client";

import {
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  CONSTRAINTS,
  EDGE_HITBOX_WIDTH,
  normalizeProgress,
  type ResizableGridHandle,
  useDragResize,
} from "../../hooks/use-drag-resize";

interface ResizableGridProps {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  initialLeft?: number;
  initialRight?: number;
  onLeftCollapsedChange?: (collapsed: boolean) => void;
}

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

const computeScale = (width: number, threshold: number) =>
  0.95 + 0.05 * normalizeProgress(width, threshold);

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
