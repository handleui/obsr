"use client";

import { Button } from "@detent/ui/button";
import { cn } from "@detent/ui/lib/utils";
import {
  TooltipContent,
  TooltipRoot,
  TooltipTrigger,
} from "@detent/ui/tooltip";
import { Check, Copy } from "iconoir-react";
import Image from "next/image";
import { memo, useCallback, useState } from "react";

interface Provider {
  name: string;
  src: string;
  size: number;
  url: string;
  cover?: boolean;
}

interface CiStep {
  label: string;
  bgClass: string;
  fgClass: string;
  hasConnector?: boolean;
}

const DETENT_PROMPT = "What is Detent self-resolving CI/CD?";
const DETENT_QUERY = encodeURIComponent(DETENT_PROMPT);

const PROVIDERS: Provider[] = [
  {
    name: "ChatGPT",
    src: "/providers/chat.svg",
    size: 14,
    url: `https://chatgpt.com/?q=${DETENT_QUERY}`,
  },
  {
    name: "Perplexity",
    src: "/providers/perplexity.svg",
    size: 16,
    url: `https://www.perplexity.ai/search?q=${DETENT_QUERY}`,
  },
];

interface AuthButton {
  label: string;
  icon: string;
  url: string;
  provider: "github" | "gitlab";
}

const getAuthButtons = (returnTo?: string): AuthButton[] => [
  {
    label: "Continue with Github",
    icon: "/providers/github-white.svg",
    url: `/auth/login?provider=github${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`,
    provider: "github",
  },
  {
    label: "Continue with Gitlab",
    icon: "/providers/gitlab.svg",
    url: `/auth/login?provider=gitlab${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`,
    provider: "gitlab",
  },
];

const CI_STEPS: CiStep[] = [
  {
    label: "Test",
    bgClass: "bg-failure-bg",
    fgClass: "text-[#e35115]",
    hasConnector: true,
  },
  {
    label: "Lint",
    bgClass: "bg-info-bg",
    fgClass: "text-info-fg",
    hasConnector: true,
  },
  {
    label: "Check Types",
    bgClass: "bg-success-bg",
    fgClass: "text-success-fg",
  },
  {
    label: "Build",
    bgClass: "bg-[#f1f1f2]",
    fgClass: "text-black",
  },
];

const ProviderIcon = memo(({ provider }: { provider: Provider }) => (
  <TooltipRoot>
    <TooltipTrigger
      className="cursor-pointer"
      render={
        // biome-ignore lint/a11y/useAnchorContent: base-ui render prop injects children at runtime
        <a
          aria-label={`Ask ${provider.name} about Detent`}
          href={provider.url}
          rel="noopener noreferrer"
          target="_blank"
        />
      }
    >
      <Image
        alt={provider.name}
        className={cn(
          provider.size === 16 ? "size-4" : "size-3.5",
          provider.cover && "object-cover"
        )}
        height={provider.size}
        src={provider.src}
        width={provider.size}
      />
    </TooltipTrigger>
    <TooltipContent>Ask {provider.name} about Detent</TooltipContent>
  </TooltipRoot>
));

const CopyPromptButton = () => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(DETENT_PROMPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  return (
    <TooltipRoot>
      <TooltipTrigger
        className="cursor-pointer text-dim hover:text-black"
        onClick={handleCopy}
        render={<button aria-label="Copy prompt" type="button" />}
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied!" : "Copy prompt"}</TooltipContent>
    </TooltipRoot>
  );
};

const CiStepRow = memo(({ step }: { step: CiStep }) => (
  <>
    <div className={cn("flex items-center p-1", step.bgClass)}>
      <span className={cn("flex-1 text-sm leading-[1.1]", step.fgClass)}>
        {step.label}
      </span>
    </div>
    {step.hasConnector && (
      <div className="px-6">
        <div className={cn("size-4", step.bgClass)} />
      </div>
    )}
  </>
));

const LoginForm = memo(
  ({ showGitlab, returnTo }: { showGitlab: boolean; returnTo?: string }) => {
    const authButtons = getAuthButtons(returnTo);
    const buttons = showGitlab
      ? authButtons
      : authButtons.filter((btn) => btn.provider === "github");

    return (
      <div className="flex w-[400px] flex-col gap-8">
        <div className="flex flex-col gap-2">
          <p className="text-black text-xl leading-[1.1]">
            Detent is the new, self-resolving CI/CD
          </p>
          <p className="text-[#575757] text-sm leading-[1.2]">
            We provide self-resolving capabilities to your CI/CD pipelines,
            cleanly extracting the errors, and turning your checks green in
            under 2 minutes.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {buttons.map((btn) => (
            <Button
              asChild
              className={cn(
                "w-full gap-2.5 rounded-none px-3 font-normal",
                btn.provider === "gitlab" &&
                  "bg-[#f5f5f5] text-black hover:bg-[#ebebeb]"
              )}
              key={btn.label}
              variant={btn.provider === "gitlab" ? "ghost" : "default"}
            >
              <a href={btn.url}>
                <Image
                  alt=""
                  className="size-4"
                  height={16}
                  priority
                  src={btn.icon}
                  width={16}
                />
                {btn.label}
              </a>
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3">
            <CopyPromptButton />
            {PROVIDERS.map((p) => (
              <ProviderIcon key={p.name} provider={p} />
            ))}
          </div>
          <span className="text-dim text-xs leading-[1.2]">&middot;</span>
          <a
            className="text-dim text-xs leading-[1.2] hover:text-black"
            href="https://detent.sh/legal"
          >
            Policies & Legal
          </a>
        </div>
      </div>
    );
  }
);

const CiPreview = () => (
  <div className="flex h-full flex-1 flex-col items-center">
    <div className="relative flex h-full w-[700px] items-center">
      <div className="absolute inset-y-0 left-8 border-subtle border-l" />
      <div className="relative flex w-full flex-col gap-2.5 bg-white py-4">
        {CI_STEPS.map((step) => (
          <CiStepRow key={step.label} step={step} />
        ))}
      </div>
    </div>
  </div>
);

interface LoginPageClientProps {
  showGitlab: boolean;
  returnTo?: string;
}

export const LoginPageClient = ({
  showGitlab,
  returnTo,
}: LoginPageClientProps) => (
  <div className="flex h-screen bg-white">
    <div className="flex h-full w-[750px] shrink-0 flex-col items-center justify-center">
      <LoginForm returnTo={returnTo} showGitlab={showGitlab} />
    </div>
    <CiPreview />
  </div>
);
