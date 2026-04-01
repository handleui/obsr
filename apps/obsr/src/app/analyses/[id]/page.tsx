import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { CopyPromptButton } from "@/components/copy-prompt-button";
import { getAnalysisDetail } from "@/lib/analysis/service";
import { isRouteNotFoundError } from "@/lib/http";

export const dynamic = "force-dynamic";

interface AnalysisDetailPageProps {
  params: Promise<{ id: string }>;
}

const AnalysisDetailPage = async ({ params }: AnalysisDetailPageProps) => {
  await connection();
  const { id } = await params;

  try {
    const analysis = await getAnalysisDetail(id);

    return (
      <main className="min-h-screen bg-canvas px-6 py-10 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-2">
              <Link
                className="text-muted text-sm transition-colors hover:text-ink"
                href="/analyses"
              >
                Back to analyses
              </Link>
              <h1 className="font-semibold text-4xl text-ink tracking-tight">
                Analysis detail
              </h1>
              <p className="text-muted text-sm">
                {new Date(analysis.createdAt).toLocaleString()} ·{" "}
                {analysis.diagnosticCount} diagnostic
                {analysis.diagnosticCount === 1 ? "" : "s"}
              </p>
            </div>

            <CopyPromptButton prompt={analysis.prompt} />
          </header>

          <section className="rounded-3xl border border-line bg-surface px-6 py-6 shadow-[0_22px_60px_rgba(40,30,20,0.06)]">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
              Summary
            </div>
            <p className="max-w-4xl text-ink text-lg leading-8">
              {analysis.summary}
            </p>
            {analysis.rawLogWasTruncated ? (
              <p className="mt-3 text-muted text-sm">
                Stored raw log was truncated after persistence bounds.
              </p>
            ) : null}
          </section>

          <section className="grid gap-4">
            {analysis.diagnostics.map((diagnostic) => (
              <article
                className="rounded-3xl border border-line bg-surface px-5 py-5"
                key={diagnostic.fingerprint}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
                      #{diagnostic.rank + 1}
                    </span>
                    {diagnostic.severity ? (
                      <span className="rounded-full bg-danger-soft px-3 py-1 text-[11px] text-danger-ink uppercase tracking-[0.18em]">
                        {diagnostic.severity}
                      </span>
                    ) : null}
                    {diagnostic.category ? (
                      <span className="rounded-full bg-ok-soft px-3 py-1 text-[11px] text-ok-ink uppercase tracking-[0.18em]">
                        {diagnostic.category}
                      </span>
                    ) : null}
                  </div>

                  <div className="text-muted text-sm">
                    {[diagnostic.source, diagnostic.ruleId]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>

                <h2 className="mt-4 font-medium text-ink text-xl leading-8">
                  {diagnostic.message}
                </h2>

                {diagnostic.filePath ? (
                  <p className="mt-2 font-mono text-[13px] text-muted">
                    {diagnostic.filePath}
                    {diagnostic.line ? `:${diagnostic.line}` : ""}
                    {diagnostic.column ? `:${diagnostic.column}` : ""}
                  </p>
                ) : null}

                <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-2xl bg-panel px-4 py-4 font-mono text-[13px] text-ink leading-6">
                  {diagnostic.evidence}
                </pre>
              </article>
            ))}
          </section>
        </div>
      </main>
    );
  } catch (error) {
    if (isRouteNotFoundError(error)) {
      notFound();
    }

    throw error;
  }
};

export default AnalysisDetailPage;
