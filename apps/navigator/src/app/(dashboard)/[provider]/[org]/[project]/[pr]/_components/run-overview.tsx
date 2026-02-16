"use client";

import { Button } from "@detent/ui/button";
import { Dropdown } from "@detent/ui/dropdown";
import { ArrowRight, Sparks } from "iconoir-react";
import { JobList } from "./job-list";
import { useRunData } from "./run-data-context";
import { RunFilters } from "./run-filters";

const AuthorBadge = ({ name }: { name: string }) => (
  <div className="flex items-center gap-2">
    <div className="flex size-[12px] items-center justify-center rounded-[2px] bg-[#d9d9d9]">
      <span className="font-medium text-[7px] text-black leading-none">
        {name.charAt(0).toUpperCase()}
      </span>
    </div>
    <p className="text-[13px] text-black leading-[1.2]">{name}</p>
  </div>
);

const BranchInfo = ({ source, target }: { source: string; target: string }) => (
  <div className="flex items-center gap-2">
    <p className="text-[13px] text-black leading-[1.2]">{source}</p>
    <ArrowRight height={12} strokeWidth={1.2} width={12} />
    <p className="text-[13px] text-black leading-[1.2]">{target}</p>
  </div>
);

const DiffStats = ({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) => (
  <div className="flex items-center gap-2 text-[13px] leading-[1.2]">
    <p className="text-[#00ec7e]">+{additions}</p>
    <p className="text-failure-fg">-{deletions}</p>
  </div>
);

const StatusBar = () => (
  <div className="flex w-full items-start gap-2.5">
    <div className="flex h-[40px] flex-1 items-center gap-2 border border-subtle px-3">
      <div className="size-2 shrink-0 bg-waiting-accent" />
      <p className="text-[13px] text-black leading-[1.4]">
        Waiting for jobs to complete
      </p>
    </div>
    <Button className="flex-1 gap-2.5 text-[14px] leading-[1.1]" type="button">
      <Sparks className="!size-3" color="white" />
      Heal All Jobs
    </Button>
  </div>
);

const PullRequestHeader = () => {
  const { run } = useRunData();

  return (
    <div className="flex w-full flex-col items-start gap-8 py-6">
      <div className="flex w-full flex-col items-start gap-5">
        <div className="flex w-full flex-col gap-3 leading-[1.2]">
          <p className="w-full text-[14px] text-muted">
            {run.org}/{run.project} #{run.pr}
          </p>
          <p className="w-full text-[24px] text-black">{run.title}</p>
        </div>
        <div className="flex items-center gap-6">
          <AuthorBadge name={run.author} />
          <BranchInfo source={run.branch.source} target={run.branch.target} />
          <p className="text-[13px] text-black leading-[1.2]">
            {run.files} files
          </p>
          <DiffStats additions={run.additions} deletions={run.deletions} />
        </div>
      </div>

      <StatusBar />

      <Dropdown label="Description">
        <div className="border border-subtle border-t-0 p-3">
          <p className="text-[13px] text-muted leading-[1.4]">
            {run.description}
          </p>
        </div>
      </Dropdown>
    </div>
  );
};

const RunOverview = () => (
  <div className="flex w-full flex-col items-center px-4 py-4">
    <PullRequestHeader />
    <RunFilters />
    <JobList />
  </div>
);

export default RunOverview;
