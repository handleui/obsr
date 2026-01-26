interface HealsPageProps {
  params: Promise<{
    provider: string;
    org: string;
    project: string;
  }>;
}

const HealsPage = async ({ params }: HealsPageProps) => {
  const { project } = await params;

  return (
    <div className="p-6">
      <h1 className="mb-6 font-bold text-2xl">AI Heals</h1>
      <p className="text-neutral-500">
        AI healing history for {project} will be available here.
      </p>
    </div>
  );
};

export default HealsPage;
