import Link from "next/link";
import { connection } from "next/server";
import { listAnalyses } from "@/lib/analysis/service";

export const dynamic = "force-dynamic";

const AnalysesPage = async () => {
  await connection();
  const analyses = await listAnalyses();

  return (
    <main className="min-h-screen bg-canvas px-6 py-10 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-muted text-sm uppercase tracking-[0.22em]">
              History
            </p>
            <h1 className="font-semibold text-4xl text-ink tracking-tight">
              Recent analyses
            </h1>
          </div>

          <Link
            className="text-muted text-sm transition-colors hover:text-ink"
            href="/"
          >
            Back to paste screen
          </Link>
        </header>

        {analyses.length === 0 ? (
          <section className="rounded-3xl border border-line border-dashed bg-surface px-6 py-12 text-center">
            <h2 className="font-medium text-ink text-xl">No analyses yet</h2>
            <p className="mt-2 text-muted">
              Create your first history entry from the paste screen.
            </p>
          </section>
        ) : (
          <section className="grid gap-4">
            {analyses.map((analysis) => (
              <Link
                className="rounded-3xl border border-line bg-surface px-5 py-5 shadow-[0_18px_54px_rgba(40,30,20,0.05)] transition-transform hover:-translate-y-0.5"
                href={`/analyses/${analysis.id}`}
                key={analysis.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
                    {analysis.inputKind}
                  </div>
                  <div className="text-muted text-sm">
                    {new Date(analysis.createdAt).toLocaleString()}
                  </div>
                </div>

                <p className="mt-4 max-w-3xl text-base text-ink leading-7">
                  {analysis.summary}
                </p>

                <div className="mt-4 text-muted text-sm">
                  {analysis.diagnosticCount} diagnostic
                  {analysis.diagnosticCount === 1 ? "" : "s"}
                </div>
              </Link>
            ))}
          </section>
        )}
      </div>
    </main>
  );
};

export default AnalysesPage;
