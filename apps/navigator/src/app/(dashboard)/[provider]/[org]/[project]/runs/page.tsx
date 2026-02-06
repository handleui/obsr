// HACK: Log viewer architecture notes (remove when implementing)
//
// Dep: @tanstack/react-virtual (~2.5KB gzipped, headless virtualizer)
//
// Why this library:
// - Headless — we fully control row DOM, critical for per-line error/warning
//   tinting driven by CIError line numbers from the AI extractor.
// - Tiny bundle — fits the lean @detent/ui philosophy (Radix + CVA + Tailwind).
// - Variable-height rows via estimateSize + measureElement — collapsed noise
//   blocks (single summary row ~36px) vs expanded lines (~20px each).
// - Container-based useVirtualizer (NOT useWindowVirtualizer) for React 19 compat.
//
// Data flow:
// 1. Fetch run.logR2Key → full raw log from R2
// 2. Fetch run.logManifest → LogSegment[] (signal/noise line ranges)
// 3. Split log into lines, map segments to virtual items:
//    - Noise segments (signal=false) → 1 collapsed item: "[lines X-Y: N lines hidden]"
//    - Signal segments (signal=true) → 1 item per line
// 4. Expand/collapse toggles re-map the flat item list, virtualizer re-renders.
// 5. Error tinting: overlay CIError.lineNumber onto visible lines for bg color.
//
// Focus mode: toggle all noise segments collapsed (default) vs expanded (full log).

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
