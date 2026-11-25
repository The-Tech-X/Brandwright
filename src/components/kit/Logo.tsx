import { cn } from "@/lib/utils";

// The Brandwright mark: a clean geometric B in white on a near-black tile, with one coral dot.
// Geometry and colours live here once; src/app/icon.svg and apple-icon.tsx repeat them.

/** Shapes and colours on a 32×32 grid, shared by every version of the mark. */
export const MARK = {
  /** The B as one stroke: stem, the top bowl back to the stem, then the slightly wider bottom bowl */
  b: "M9 25V7h6a4.5 4.5 0 0 1 0 9H9h7a4.5 4.5 0 0 1 0 9H9Z",
  stroke: 3.5,
  dot: { cx: 24, cy: 24, r: 2.25 },
  tile: "#15171c",
  ink: "#ffffff",
  accent: "#ff7a59",
} as const;

export function LogoMark({ size = 32, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      // A hairline outline in dark mode, so the near-black tile still shows on dark backgrounds
      className={cn("shrink-0 dark:ring-1 dark:ring-white/15", className)}
      style={{ borderRadius: size / 4 }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <rect width="32" height="32" rx="8" fill={MARK.tile} />
      <path d={MARK.b} fill="none" stroke={MARK.ink} strokeWidth={MARK.stroke} strokeLinejoin="round" />
      <circle {...MARK.dot} fill={MARK.accent} />
    </svg>
  );
}

const WORD_SIZE = { sm: "text-base", md: "text-lg", lg: "text-[26px]" } as const;
const MARK_SIZE = { sm: 24, md: 30, lg: 40 } as const;

/** Mark + "Brandwright" wordmark. */
export function Logo({
  size = "md",
  tone = "default",
  className,
}: {
  size?: keyof typeof WORD_SIZE;
  tone?: "default" | "onDark";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 font-ob", className)}>
      <LogoMark size={MARK_SIZE[size]} />
      <span className={cn("font-extrabold leading-none tracking-[-0.03em]", WORD_SIZE[size], tone === "onDark" ? "text-ob-on-dark" : "text-ob-ink")}>
        Brandwright
      </span>
    </span>
  );
}
