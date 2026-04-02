"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { MAX_RAW_TEXT_CHARS } from "@/lib/issues/constants";
import type {
  IssueEnvironment,
  ObservationSourceKind,
} from "@/lib/issues/schema";

const textPlaceholder = `bun run check-types
src/app/page.tsx:17:9 - error TS2322: Type 'string' is not assignable to type 'number'`;

const sentryPlaceholder = `{
  "title": "TypeError: Cannot read properties of undefined",
  "level": "error",
  "culprit": "src/app/page.tsx",
  "event_id": "9d42f6d4c1c14d499ce4",
  "exception": {
    "values": [
      {
        "type": "TypeError",
        "value": "Cannot read properties of undefined",
        "stacktrace": {
          "frames": [
            {
              "filename": "src/app/page.tsx",
              "lineno": 42,
              "colno": 13,
              "in_app": true
            }
          ]
        }
      }
    ]
  }
}`;

const readErrorMessage = async (response: Response) => {
  const fallback = response.status
    ? `Issue creation failed (${response.status}).`
    : "Issue creation failed.";

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (payload?.error?.message) {
      return payload.error.message;
    }
  }

  try {
    const body = (await response.text()).trim();
    return body || fallback;
  } catch {
    return fallback;
  }
};

const normalizeOptional = (value: string) => {
  const trimmed = value.trim();
  return trimmed || undefined;
};

const isSentryInput = (sourceKind: ObservationSourceKind) => {
  return sourceKind === "sentry";
};

const emptyDrafts: Record<ObservationSourceKind, string> = {
  "manual-log": "",
  ci: "",
  "runtime-log": "",
  "dev-server": "",
  sentry: "",
};

export const IssueIntakeForm = () => {
  const router = useRouter();
  const [sourceKind, setSourceKind] =
    useState<ObservationSourceKind>("manual-log");
  const [environment, setEnvironment] = useState<IssueEnvironment>("local");
  const [rawInputBySource, setRawInputBySource] =
    useState<Record<ObservationSourceKind, string>>(emptyDrafts);
  const [repo, setRepo] = useState("");
  const [app, setApp] = useState("");
  const [service, setService] = useState("");
  const [branch, setBranch] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const rawInput = rawInputBySource[sourceKind];
  const hasInput = rawInput.trim().length > 0;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    let shouldReleaseSubmitLock = true;

    try {
      const body: Record<string, unknown> = {
        sourceKind,
        context: {
          environment,
          repo: normalizeOptional(repo),
          app: normalizeOptional(app),
          service: normalizeOptional(service),
          branch: normalizeOptional(branch),
          command: normalizeOptional(command),
        },
      };

      if (isSentryInput(sourceKind)) {
        try {
          body.rawPayload = JSON.parse(rawInput);
        } catch {
          setError("Sentry input must be valid JSON.");
          return;
        }
      } else {
        body.rawText = rawInput;
      }

      const response = await fetch("/api/issues", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }

      const payload = (await response.json()) as { id: string };
      shouldReleaseSubmitLock = false;
      router.push(`/issues/${payload.id}`);
    } catch {
      setError("Network error while creating the issue.");
    } finally {
      if (shouldReleaseSubmitLock) {
        setIsSubmitting(false);
      }
    }
  };

  return (
    <form
      className="grid gap-4 rounded-3xl border border-line bg-surface p-5 shadow-[0_24px_70px_rgba(40,30,20,0.07)]"
      onSubmit={handleSubmit}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-2xl text-ink">Create issue</h2>
          <p className="mt-1 text-muted text-sm">
            ObsR stores one raw observation, extracts diagnostics, clusters
            related evidence, and writes back one issue in plain English.
          </p>
        </div>

        <button
          className="inline-flex h-11 items-center justify-center rounded-full bg-accent px-5 font-medium text-sm text-white shadow-[0_14px_28px_rgba(184,86,42,0.22)] disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isSubmitting || !hasInput}
          type="submit"
        >
          {isSubmitting ? "Creating..." : "Create issue"}
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <label className="grid gap-2">
          <span className="font-medium text-ink text-sm">Source kind</span>
          <select
            className="h-11 rounded-2xl border border-line bg-panel px-4 text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
            disabled={isSubmitting}
            onChange={(event) => {
              setError(null);
              setSourceKind(event.target.value as ObservationSourceKind);
            }}
            value={sourceKind}
          >
            <option value="manual-log">manual-log</option>
            <option value="ci">ci</option>
            <option value="runtime-log">runtime-log</option>
            <option value="dev-server">dev-server</option>
            <option value="sentry">sentry</option>
          </select>
        </label>

        <label className="grid gap-2">
          <span className="font-medium text-ink text-sm">Environment</span>
          <select
            className="h-11 rounded-2xl border border-line bg-panel px-4 text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
            disabled={isSubmitting}
            onChange={(event) =>
              setEnvironment(event.target.value as IssueEnvironment)
            }
            value={environment}
          >
            <option value="local">local</option>
            <option value="ci">ci</option>
            <option value="preview">preview</option>
            <option value="production">production</option>
            <option value="unknown">unknown</option>
          </select>
        </label>

        <label className="grid gap-2">
          <span className="font-medium text-ink text-sm">Repo</span>
          <input
            className="h-11 rounded-2xl border border-line bg-panel px-4 text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
            disabled={isSubmitting}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="obsr"
            value={repo}
          />
        </label>

        <label className="grid gap-2">
          <span className="font-medium text-ink text-sm">App</span>
          <input
            className="h-11 rounded-2xl border border-line bg-panel px-4 text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
            disabled={isSubmitting}
            onChange={(event) => setApp(event.target.value)}
            placeholder="web"
            value={app}
          />
        </label>

        <label className="grid gap-2">
          <span className="font-medium text-ink text-sm">Service</span>
          <input
            className="h-11 rounded-2xl border border-line bg-panel px-4 text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
            disabled={isSubmitting}
            onChange={(event) => setService(event.target.value)}
            placeholder="api"
            value={service}
          />
        </label>

        <label className="grid gap-2">
          <span className="font-medium text-ink text-sm">Branch</span>
          <input
            className="h-11 rounded-2xl border border-line bg-panel px-4 text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
            disabled={isSubmitting}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="handle/issue-layer"
            value={branch}
          />
        </label>

        <label className="grid gap-2 md:col-span-2 xl:col-span-3">
          <span className="font-medium text-ink text-sm">Command / flow</span>
          <input
            className="h-11 rounded-2xl border border-line bg-panel px-4 text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
            disabled={isSubmitting}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="bun run check-types"
            value={command}
          />
        </label>
      </div>

      <label className="grid gap-2">
        <span className="font-medium text-ink text-sm">
          {isSentryInput(sourceKind) ? "Sentry payload" : "Raw input"}
        </span>
        <textarea
          aria-busy={isSubmitting}
          aria-describedby={error ? "issue-intake-error" : undefined}
          aria-invalid={Boolean(error)}
          className="min-h-[360px] rounded-3xl border border-line bg-panel px-4 py-4 font-mono text-[13px] text-ink leading-6 outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
          disabled={isSubmitting}
          maxLength={MAX_RAW_TEXT_CHARS}
          onChange={(event) =>
            setRawInputBySource((current) => ({
              ...current,
              [sourceKind]: event.target.value,
            }))
          }
          placeholder={
            isSentryInput(sourceKind) ? sentryPlaceholder : textPlaceholder
          }
          required
          spellCheck={false}
          value={rawInput}
        />
      </label>

      {error ? (
        <output
          aria-live="assertive"
          className="rounded-2xl border border-danger-ink/20 bg-danger-soft px-4 py-3 text-danger-ink text-sm"
          id="issue-intake-error"
          role="alert"
        >
          {error}
        </output>
      ) : null}
    </form>
  );
};
