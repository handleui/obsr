"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, startTransition, useState } from "react";

const placeholderLog = `bun run check-types
src/app/page.tsx:17:9 - error TS2322: Type 'string' is not assignable to type 'number'`;

const readErrorMessage = async (response: Response) => {
  const fallback = response.status
    ? `Analysis failed (${response.status}).`
    : "Analysis failed.";

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

export const AnalyzeForm = () => {
  const router = useRouter();
  const [rawLog, setRawLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const hasInput = rawLog.trim().length > 0;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/analyses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          inputKind: "paste",
          rawLog,
        }),
      });

      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }

      const payload = (await response.json()) as { id: string };
      startTransition(() => {
        router.push(`/analyses/${payload.id}`);
      });
    } catch {
      setError("Network error while creating the analysis.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      className="grid gap-4 rounded-3xl border border-line bg-surface p-5 shadow-[0_24px_70px_rgba(40,30,20,0.07)]"
      onSubmit={handleSubmit}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-2xl text-ink">Paste CI output</h2>
          <p className="mt-1 text-muted text-sm">
            One paste can produce many distinct diagnostics. Empty or oversized
            inputs are rejected before persistence.
          </p>
        </div>

        <button
          className="inline-flex h-11 items-center justify-center rounded-full bg-accent px-5 font-medium text-sm text-white shadow-[0_14px_28px_rgba(184,86,42,0.22)] disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isSubmitting || !hasInput}
          type="submit"
        >
          {isSubmitting ? "Analyzing..." : "Analyze log"}
        </button>
      </div>

      <label className="grid gap-2">
        <span className="font-medium text-ink text-sm">Pasted log</span>
        <textarea
          aria-busy={isSubmitting}
          className="min-h-[360px] rounded-3xl border border-line bg-panel px-4 py-4 font-mono text-[13px] text-ink leading-6 outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
          disabled={isSubmitting}
          onChange={(event) => setRawLog(event.target.value)}
          placeholder={placeholderLog}
          required
          value={rawLog}
        />
      </label>

      {error ? (
        <output className="rounded-2xl border border-danger-ink/20 bg-danger-soft px-4 py-3 text-danger-ink text-sm">
          {error}
        </output>
      ) : null}
    </form>
  );
};
