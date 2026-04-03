const IssuesPage = () => {
  return (
    <main className="min-h-screen bg-canvas px-6 py-10 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <section className="rounded-3xl border border-line bg-surface px-6 py-8 shadow-[0_20px_60px_rgba(40,30,20,0.08)] sm:px-8">
          <p className="text-muted text-sm uppercase tracking-[0.22em]">
            Issues
          </p>
          <h1 className="mt-3 font-semibold text-4xl text-ink tracking-tight">
            Issue history UI is intentionally empty.
          </h1>
          <p className="mt-4 max-w-2xl text-base text-muted leading-7">
            The route is reserved, but issue browsing stays off until the
            authenticated product surface is ready.
          </p>
        </section>
      </div>
    </main>
  );
};

export default IssuesPage;
