interface RunsPageProps {
  params: Promise<{
    provider: string;
    org: string;
    project: string;
  }>;
}

const RunsPage = async ({ params }: RunsPageProps) => {
  const { project } = await params;

  return (
    <div className="p-6">
      <h1 className="mb-6 font-bold text-2xl">CI Runs</h1>
      <p className="text-neutral-500">
        CI run history for {project} will be available here.
      </p>
    </div>
  );
};

export default RunsPage;
