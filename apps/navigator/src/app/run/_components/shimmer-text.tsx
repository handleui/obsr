import type { ReactNode } from "react";

interface ShimmerTextProps {
  children: ReactNode;
  color: string;
  peakColor: string;
  className?: string;
  animation?: string;
}

const ShimmerText = ({
  children,
  color,
  peakColor,
  className,
  animation = "animate-shimmer-sweep",
}: ShimmerTextProps) => (
  <span
    className={`${animation} bg-clip-text text-transparent ${className ?? ""}`}
    style={{
      backgroundImage: `linear-gradient(90deg, #0000 33%, ${peakColor} 50%, #0000 67%), linear-gradient(${color}, ${color})`,
      backgroundSize: "300% 100%, auto",
    }}
  >
    {children}
  </span>
);

export { ShimmerText };
export type { ShimmerTextProps };
