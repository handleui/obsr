"use client";

import { Accordion } from "@base-ui-components/react/accordion";
import { NavArrowDown } from "iconoir-react";
import type * as React from "react";

import { cn } from "../../lib/utils";

interface DropdownProps {
  label: string;
  children: React.ReactNode;
  className?: string;
  defaultOpen?: boolean;
}

const Dropdown = ({
  label,
  children,
  className,
  defaultOpen = false,
}: DropdownProps) => (
  <Accordion.Root
    className={cn("w-full", className)}
    defaultValue={defaultOpen ? [0] : undefined}
  >
    <Accordion.Item value={0}>
      <Accordion.Header>
        <Accordion.Trigger className="group flex h-[40px] w-full cursor-pointer items-center gap-[10px] border border-subtle p-3 hover:border-b-black">
          <span className="flex-1 text-left text-[13px] text-black leading-[1.4] tracking-[-0.39px]">
            {label}
          </span>
          <NavArrowDown className="size-3 text-black group-data-[panel-open]:rotate-180" />
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Panel className="overflow-hidden bg-surface">
        {children}
      </Accordion.Panel>
    </Accordion.Item>
  </Accordion.Root>
);

export { Dropdown };
export type { DropdownProps };
