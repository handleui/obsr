const Home = () => {
  return (
    <main className="min-h-screen bg-canvas px-6 py-10 text-ink sm:px-8">
      <div className="mx-auto max-w-4xl">
        <section className="rounded-3xl border border-line bg-surface px-6 py-8 shadow-[0_20px_60px_rgba(40,30,20,0.08)] sm:px-8">
          <p className="text-muted text-sm uppercase tracking-[0.22em]">ObsR</p>
          <h1 className="mt-3 font-semibold text-4xl tracking-tight">
            This app surface is intentionally empty right now.
          </h1>
          <p className="mt-4 max-w-2xl text-base text-muted leading-7">
            Auth and issue ownership are being wired behind the API first. This
            route stays in place so the path is reserved while the product UI is
            still being designed.
          </p>
        </section>
      </div>
    </main>
  );
};

export default Home;
