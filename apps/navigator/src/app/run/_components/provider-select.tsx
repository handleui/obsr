"use client";

import { Select } from "@base-ui-components/react/select";
import {
  TooltipContent,
  TooltipRoot,
  TooltipTrigger,
} from "@detent/ui/tooltip";
import { NavArrowDown } from "iconoir-react";
import Image from "next/image";
import { useRef, useState } from "react";

interface Provider {
  name: string;
  icon: string;
  url: string;
}

const PROVIDERS: Provider[] = [
  {
    name: "Graphite",
    icon: "/providers/graphite.svg",
    url: "https://app.graphite.com/github/pr/detentsh/detent/159",
  },
  {
    name: "GitHub",
    icon: "/providers/github.svg",
    url: "https://github.com/detentsh/detent/pull/159",
  },
];

const DEFAULT_PROVIDER = PROVIDERS[0];

const ProviderIcon = ({ src }: { src: string }) => (
  <Image alt="" className="size-3" height={12} src={src} width={12} />
);

const OpenLink = ({ provider }: { provider: Provider }) => (
  <TooltipRoot>
    <TooltipTrigger
      className="flex h-full items-center justify-center gap-2 border-subtle border-l px-3 hover:bg-surface"
      render={
        // biome-ignore lint/a11y/useAnchorContent: content provided by TooltipTrigger children
        <a href={provider.url} rel="noopener noreferrer" target="_blank" />
      }
    >
      <ProviderIcon src={provider.icon} />
      <span className="font-geist text-[12px] text-black">Open</span>
    </TooltipTrigger>
    <TooltipContent>Open in {provider.name}</TooltipContent>
  </TooltipRoot>
);

const ProviderDropdown = ({
  anchorRef,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) => (
  <Select.Portal>
    <Select.Positioner
      align="end"
      alignItemWithTrigger={false}
      anchor={anchorRef}
      side="bottom"
      sideOffset={0}
    >
      <Select.Popup className="w-[var(--anchor-width)] border border-subtle border-t-0 border-r-0 bg-white">
        <Select.List>
          {PROVIDERS.map((provider) => (
            <Select.Item
              className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px] text-black data-[highlighted]:bg-surface"
              key={provider.name}
              value={provider.name}
            >
              <ProviderIcon src={provider.icon} />
              <Select.ItemText>{provider.name}</Select.ItemText>
            </Select.Item>
          ))}
        </Select.List>
      </Select.Popup>
    </Select.Positioner>
  </Select.Portal>
);

const ProviderSelect = () => {
  const [selected, setSelected] = useState(DEFAULT_PROVIDER);
  const anchorRef = useRef<HTMLDivElement>(null);

  const handleValueChange = (value: string | null) => {
    const match = PROVIDERS.find((p) => p.name === value);
    if (match) {
      setSelected(match);
    }
  };

  return (
    <Select.Root
      defaultValue={DEFAULT_PROVIDER.name}
      onValueChange={handleValueChange}
    >
      <div className="flex h-10 items-center" ref={anchorRef}>
        <OpenLink provider={selected} />
        <TooltipRoot>
          <TooltipTrigger render={<span />}>
            <Select.Trigger className="flex size-10 cursor-pointer items-center justify-center border-subtle border-l hover:bg-surface">
              <Select.Icon>
                <NavArrowDown height={12} strokeWidth={1.2} width={12} />
              </Select.Icon>
            </Select.Trigger>
          </TooltipTrigger>
          <TooltipContent>Switch provider</TooltipContent>
        </TooltipRoot>
      </div>
      <ProviderDropdown anchorRef={anchorRef} />
    </Select.Root>
  );
};

export default ProviderSelect;
