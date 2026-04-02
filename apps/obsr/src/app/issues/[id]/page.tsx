import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { CopyIssueBriefButton } from "@/components/copy-issue-brief-button";
import { isRouteNotFoundError } from "@/lib/http";
import { getIssueDetailView } from "@/lib/issues/service";

export const dynamic = "force-dynamic";

interface IssueDetailPageProps {
  params: Promise<{ id: string }>;
}

const IssueDetailPage = async ({ params }: IssueDetailPageProps) => {
  await connection();
  const { id } = await params;

  try {
    const issue = await getIssueDetailView(id);

    return (
      <main className="min-h-screen bg-canvas px-6 py-10 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-2">
              <Link
                className="text-muted text-sm transition-colors hover:text-ink"
                href="/issues"
              >
                Back to issues
              </Link>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full bg-danger-soft px-3 py-1 text-[11px] text-danger-ink uppercase tracking-[0.18em]">
                  {issue.severity}
                </span>
                <span className="rounded-full bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
                  {issue.status}
                </span>
              </div>
              <h1 className="font-semibold text-4xl text-ink tracking-tight">
                {issue.title}
              </h1>
              <p className="text-muted text-sm">
                {new Date(issue.lastSeenAt).toLocaleString()} ·{" "}
                {issue.observationCount} observation
                {issue.observationCount === 1 ? "" : "s"} ·{" "}
                {issue.diagnosticCount} diagnostic
                {issue.diagnosticCount === 1 ? "" : "s"}
              </p>
            </div>

            <CopyIssueBriefButton brief={issue.brief} />
          </header>

          <section className="rounded-3xl border border-line bg-surface px-6 py-6 shadow-[0_22px_60px_rgba(40,30,20,0.06)]">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
              Summary
            </div>
            <p className="max-w-4xl text-ink text-lg leading-8">
              {issue.summary}
            </p>
            {issue.rootCause ? (
              <p className="mt-4 max-w-4xl text-base text-muted leading-7">
                Root cause hypothesis: {issue.rootCause}
              </p>
            ) : null}
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <article className="rounded-3xl border border-line bg-surface px-5 py-5">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
                Plan
              </div>
              <p className="text-ink leading-7">{issue.plan.summary}</p>
              <ol className="mt-4 grid gap-3 text-muted text-sm">
                {issue.plan.steps.map((step, index) => (
                  <li key={`${index}:${step}`}>
                    {index + 1}. {step}
                  </li>
                ))}
              </ol>
            </article>

            <article className="rounded-3xl border border-line bg-surface px-5 py-5">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
                Validation
              </div>
              <ul className="grid gap-3 text-muted text-sm">
                {issue.plan.validation.map((step, index) => (
                  <li key={`${index}:${step}`}>{step}</li>
                ))}
              </ul>
              {issue.plan.blockers.length > 0 ? (
                <>
                  <div className="mt-5 mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
                    Blockers
                  </div>
                  <ul className="grid gap-3 text-muted text-sm">
                    {issue.plan.blockers.map((step, index) => (
                      <li key={`${index}:${step}`}>{step}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </article>
          </section>

          <section className="grid gap-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
              Observations
            </div>
            {issue.observations.map((observation) => (
              <article
                className="rounded-3xl border border-line bg-surface px-5 py-5"
                key={observation.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
                      {observation.sourceKind}
                    </span>
                    <span className="rounded-full bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
                      {observation.context.environment}
                    </span>
                  </div>
                  <div className="text-muted text-sm">
                    {new Date(observation.capturedAt).toLocaleString()}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-3 text-muted text-sm">
                  {observation.context.repo ? (
                    <span>repo: {observation.context.repo}</span>
                  ) : null}
                  {observation.context.app ? (
                    <span>app: {observation.context.app}</span>
                  ) : null}
                  {observation.context.service ? (
                    <span>service: {observation.context.service}</span>
                  ) : null}
                  {observation.context.command ? (
                    <span>command: {observation.context.command}</span>
                  ) : null}
                  {observation.wasRedacted ? <span>redacted</span> : null}
                  {observation.wasTruncated ? <span>truncated</span> : null}
                </div>
              </article>
            ))}
          </section>

          <section className="grid gap-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted uppercase tracking-[0.18em]">
              Diagnostics
            </div>
            {issue.diagnostics.map((diagnostic) => (
              <article
                className="rounded-3xl border border-line bg-surface px-5 py-5"
                key={diagnostic.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2">
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

export default IssueDetailPage;
