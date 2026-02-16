"use client";

import { Select } from "@base-ui-components/react/select";
import { ArrowSeparateVertical, BookmarkBook } from "iconoir-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAllOrgs, getDefaultRun, getProjectsForOrg } from "./mock-data";
import { useRunData } from "./run-data-context";

interface SelectOption {
  label: string;
}

interface HeaderSelectProps {
  items: SelectOption[];
  value: string;
  icon: ReactNode;
  showDivider?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onValueChange: (value: string | null) => void;
  onTriggerMouseEnter: () => void;
  onPopupMouseEnter: () => void;
  onPopupMouseLeave: () => void;
}

const HeaderSelect = ({
  items,
  value,
  icon,
  showDivider,
  open,
  onOpenChange,
  onValueChange,
  onTriggerMouseEnter,
  onPopupMouseEnter,
  onPopupMouseLeave,
}: HeaderSelectProps) => (
  <Select.Root
    onOpenChange={onOpenChange}
    onValueChange={onValueChange}
    open={open}
    value={value}
  >
    {/* biome-ignore lint/a11y/noStaticElementInteractions: hover zone for sliding dropdown */}
    {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: hover zone for sliding dropdown */}
    <div
      className={`flex flex-1 ${showDivider ? "border-subtle border-r" : ""}`}
      onMouseEnter={onTriggerMouseEnter}
    >
      <Select.Trigger className="flex h-10 w-full cursor-pointer items-center justify-between overflow-clip hover:bg-surface">
        <div className="flex items-center">
          <div className="flex size-10 items-center justify-center">{icon}</div>
          <span className="pb-0.5 text-[14px] text-black leading-[1.1] tracking-[-0.42px]">
            <Select.Value />
          </span>
        </div>
        <div className="flex size-10 items-center justify-center">
          <Select.Icon>
            <ArrowSeparateVertical height={12} strokeWidth={1.2} width={12} />
          </Select.Icon>
        </div>
      </Select.Trigger>
    </div>
    <Select.Portal>
      <Select.Positioner
        align="start"
        alignItemWithTrigger={false}
        side="bottom"
        sideOffset={1}
      >
        <Select.Popup
          className="w-[var(--anchor-width)] border border-subtle border-t-0 bg-white"
          onMouseEnter={onPopupMouseEnter}
          onMouseLeave={onPopupMouseLeave}
        >
          <Select.List>
            {items.map((item) => (
              <Select.Item
                className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[14px] text-black data-[highlighted]:bg-surface"
                key={item.label}
                value={item.label}
              >
                {icon}
                <Select.ItemText>{item.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>
);

const SidebarHeader = ({
  showTrailingDivider,
}: {
  showTrailingDivider?: boolean;
} = {}) => {
  const { run } = useRunData();
  const router = useRouter();

  const orgs = useMemo(() => getAllOrgs().map((label) => ({ label })), []);

  const repos = useMemo(
    () => getProjectsForOrg(run.org).map((label) => ({ label })),
    [run.org]
  );

  const [activeSelect, setActiveSelect] = useState<"org" | "repo" | null>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  useEffect(() => {
    return () => clearTimeout(closeTimeoutRef.current);
  }, []);

  const handleOrgMouseEnter = useCallback(() => {
    clearTimeout(closeTimeoutRef.current);
    setActiveSelect((prev) => (prev !== null ? "org" : prev));
  }, []);

  const handleRepoMouseEnter = useCallback(() => {
    clearTimeout(closeTimeoutRef.current);
    setActiveSelect((prev) => (prev !== null ? "repo" : prev));
  }, []);

  const handleMouseLeave = useCallback(() => {
    closeTimeoutRef.current = setTimeout(() => setActiveSelect(null), 150);
  }, []);

  const handlePopupMouseEnter = useCallback(() => {
    clearTimeout(closeTimeoutRef.current);
  }, []);

  const handleOrgOpenChange = useCallback((open: boolean) => {
    setActiveSelect((prev) => {
      if (open) {
        return "org";
      }
      return prev === "org" ? null : prev;
    });
  }, []);

  const handleRepoOpenChange = useCallback((open: boolean) => {
    setActiveSelect((prev) => {
      if (open) {
        return "repo";
      }
      return prev === "repo" ? null : prev;
    });
  }, []);

  const handleOrgChange = useCallback(
    (newOrg: string | null) => {
      if (!newOrg || newOrg === run.org) {
        return;
      }
      const projects = getProjectsForOrg(newOrg);
      const targetProject = projects[0] ?? run.project;
      const targetRun = getDefaultRun(newOrg, targetProject);
      if (targetRun) {
        router.push(`/${newOrg}/${targetProject}/${targetRun}`);
      }
    },
    [run.org, run.project, router]
  );

  const handleRepoChange = useCallback(
    (newProject: string | null) => {
      if (!newProject || newProject === run.project) {
        return;
      }
      const targetRun = getDefaultRun(run.org, newProject);
      if (targetRun) {
        router.push(`/${run.org}/${newProject}/${targetRun}`);
      }
    },
    [run.org, run.project, router]
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover zone for sliding dropdown
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: hover zone for sliding dropdown
    <div className="flex items-center" onMouseLeave={handleMouseLeave}>
      <HeaderSelect
        icon={
          <Image
            alt=""
            className="size-3"
            height={12}
            src="/providers/github.svg"
            width={12}
          />
        }
        items={orgs}
        onOpenChange={handleOrgOpenChange}
        onPopupMouseEnter={handlePopupMouseEnter}
        onPopupMouseLeave={handleMouseLeave}
        onTriggerMouseEnter={handleOrgMouseEnter}
        onValueChange={handleOrgChange}
        open={activeSelect === "org"}
        showDivider
        value={run.org}
      />
      <HeaderSelect
        icon={<BookmarkBook height={12} strokeWidth={1.5} width={12} />}
        items={repos}
        onOpenChange={handleRepoOpenChange}
        onPopupMouseEnter={handlePopupMouseEnter}
        onPopupMouseLeave={handleMouseLeave}
        onTriggerMouseEnter={handleRepoMouseEnter}
        onValueChange={handleRepoChange}
        open={activeSelect === "repo"}
        showDivider={showTrailingDivider}
        value={run.project}
      />
    </div>
  );
};

export default SidebarHeader;
