type StatusVariant = "failure" | "waiting" | "info";

const STATUS_STYLES: Record<StatusVariant, { bg: string; fg: string }> = {
  failure: { bg: "bg-failure-bg", fg: "text-failure-fg" },
  waiting: { bg: "bg-waiting-bg", fg: "text-waiting-fg" },
  info: { bg: "bg-info-bg", fg: "text-info-fg" },
};

interface StatusBadgeProps {
  count: number;
  variant: StatusVariant;
}

const StatusBadge = ({ count, variant }: StatusBadgeProps) => (
  <div
    className={`flex size-4 items-center justify-center overflow-clip ${STATUS_STYLES[variant].bg} p-1`}
  >
    <p className={`text-[12px] ${STATUS_STYLES[variant].fg} leading-[1.1]`}>
      {count}
    </p>
  </div>
);

export { StatusBadge };
export type { StatusBadgeProps, StatusVariant };
