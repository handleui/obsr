"use client";

import { Tooltip } from "@base-ui-components/react/tooltip";
import type * as React from "react";

import { cn } from "../../lib/utils";

const TooltipProvider = Tooltip.Provider;

const TooltipRoot = Tooltip.Root;

const TooltipTrigger = Tooltip.Trigger;

interface TooltipContentProps
  extends React.ComponentPropsWithoutRef<typeof Tooltip.Popup> {
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  align?: "start" | "center" | "end";
}

const TooltipContent = ({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  children,
  ...props
}: TooltipContentProps) => (
  <Tooltip.Portal>
    <Tooltip.Positioner align={align} side={side} sideOffset={sideOffset}>
      <Tooltip.Popup
        className={cn(
          "max-w-xs bg-black px-1.5 py-0.5 text-white text-xs",
          "transition-opacity duration-150",
          "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
          className
        )}
        {...props}
      >
        {children}
      </Tooltip.Popup>
    </Tooltip.Positioner>
  </Tooltip.Portal>
);

export { TooltipContent, TooltipProvider, TooltipRoot, TooltipTrigger };
