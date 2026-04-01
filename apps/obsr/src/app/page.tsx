import Link from "next/link";
import { AnalyzeForm } from "@/components/analyze-form";

const Home = () => {
  return (
    <main className="min-h-screen bg-canvas px-6 py-10 text-ink sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-4 rounded-3xl border border-line bg-surface px-6 py-6 shadow-[0_20px_60px_rgba(40,30,20,0.08)] sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-muted text-xs uppercase tracking-[0.22em]">
              Observer MVP
            </div>
            <Link
              className="text-muted text-sm transition-colors hover:text-ink"
              href="/analyses"
            >
              Recent analyses
            </Link>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-3">
              <h1 className="max-w-3xl font-semibold text-4xl tracking-tight sm:text-5xl">
                Turn pasted CI noise into a ranked fix list.
              </h1>
              <p className="max-w-2xl text-base text-muted leading-7 sm:text-lg">
                Paste a failing log, extract distinct diagnostics, save a
                compact history entry, and copy an agent-ready prompt without
                touching the legacy docs app.
              </p>
            </div>

            <div className="grid gap-3 rounded-2xl border border-line bg-panel p-4 text-muted text-sm">
              <div>
                <div className="font-medium text-ink">MVP flow</div>
                <div>Paste log to analyze, review, and copy prompt</div>
              </div>
              <div>
                <div className="font-medium text-ink">Adapters</div>
                <div>`paste` now, auto-fetch adapters later</div>
              </div>
              <div>
                <div className="font-medium text-ink">History</div>
                <div>Minimal persisted analyses with per-analysis dedupe</div>
              </div>
            </div>
          </div>
        </header>

        <AnalyzeForm />
      </div>
    </main>
  );
};

export default Home;
