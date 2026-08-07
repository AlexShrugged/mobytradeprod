import { cn } from "@/lib/utils";

// Segmented HTS rendering: heading · subheading · statistical tail. With a
// comparison code, only the segments that diverge highlight — showing at a
// glance whether a classification dispute is at heading, subheading, or
// stat-suffix level. Server-safe; highlight the FILED side only (pass the
// expected code as compareTo), never both.
const SEGMENTS: [number, number][] = [
  [0, 4],
  [4, 6],
  [6, 8],
  [8, 10],
];

export function HtsCode({
  code,
  compareTo,
  className,
}: {
  code: string;
  compareTo?: string | null;
  className?: string;
}) {
  const digits = code.replace(/\D/g, "");
  const other = compareTo ? compareTo.replace(/\D/g, "") : null;

  const parts = SEGMENTS.map(([from, to]) => ({
    text: digits.slice(from, to),
    diff: other !== null && digits.slice(from, to) !== other.slice(from, to),
    // Dots render after the heading and subheading: 8714.94.3080.
    dotted: to === 4 || to === 6,
  })).filter((s) => s.text.length > 0);

  if (parts.length === 0) return <span className={className}>—</span>;

  return (
    <span className={cn("whitespace-nowrap tabular-nums", className)}>
      {parts.map((s, i) => (
        <span key={i}>
          <span
            className={cn(
              s.diff && "font-medium text-amber-700 dark:text-amber-400",
            )}
          >
            {s.text}
          </span>
          {s.dotted && i < parts.length - 1 ? (
            <span className="text-muted-foreground">.</span>
          ) : null}
        </span>
      ))}
    </span>
  );
}
