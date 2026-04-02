import Link from "next/link";
import { connection } from "next/server";
import { listIssues } from "@/lib/issues/service";

export const dynamic = "force-dynamic";

const IssuesPage = async () => {
  await connection();
  const issues = await listIssues();

  return (
    <main className="min-h-screen bg-canvas px-6 py-10 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-muted text-sm uppercase tracking-[0.22em]">
              History
            </p>
            <h1 className="font-semibold text-4xl text-ink tracking-tight">
              Recent issues
            </h1>
          </div>

          <Link
            className="text-muted text-sm transition-colors hover:text-ink"
            href="/"
          >
            Back to intake
          </Link>
        </header>

        {issues.length === 0 ? (
          <section className="rounded-3xl border border-line border-dashed bg-surface px-6 py-12 text-center">
            <h2 className="font-medium text-ink text-xl">No issues yet</h2>
            <p className="mt-2 text-muted">
              Create the first issue from raw input on the intake screen.
            </p>
          </section>
        ) : (
          <section className="grid gap-4">
            {issues.map((issue) => (
              <Link
                className="rounded-3xl border border-line bg-surface px-5 py-5 shadow-[0_18px_54px_rgba(40,30,20,0.05)] transition-transform hover:-translate-y-0.5"
                href={`/issues/${issue.id}`}
                key={issue.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2">
                    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
                      {issue.severity}
                    </span>
                    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
                      {issue.status}
                    </span>
                  </div>
                  <div className="text-muted text-sm">
                    {new Date(issue.lastSeenAt).toLocaleString()}
                  </div>
                </div>

                <h2 className="mt-4 font-medium text-ink text-xl">
                  {issue.title}
                </h2>
                <p className="mt-3 max-w-3xl text-base text-ink leading-7">
                  {issue.summary}
                </p>

                <div className="mt-4 flex flex-wrap gap-3 text-muted text-sm">
                  <span>
                    {issue.observationCount} observation
                    {issue.observationCount === 1 ? "" : "s"}
                  </span>
                  <span>
                    {issue.diagnosticCount} diagnostic
                    {issue.diagnosticCount === 1 ? "" : "s"}
                  </span>
                  <span>{issue.sourceKinds.join(", ")}</span>
                </div>
              </Link>
            ))}
          </section>
        )}
      </div>
    </main>
  );
};

export default IssuesPage;
