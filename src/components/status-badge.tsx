import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// The one status→tone lookup. Every status-ish string in the app renders
// through here so colors stay consistent across pages.
type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "violet";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground border-transparent",
  blue: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  green:
    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  amber:
    "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  red: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
  violet:
    "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20",
};

const statusMeta: Record<string, { label: string; tone: Tone }> = {
  // entries
  draft: { label: "Draft", tone: "neutral" },
  filed: { label: "Filed", tone: "blue" },
  released: { label: "Released", tone: "green" },
  liquidated: { label: "Liquidated", tone: "violet" },
  // future entries (derived projection)
  projected: { label: "Projected", tone: "amber" },
  // shipments
  booked: { label: "Booked", tone: "neutral" },
  in_transit: { label: "In transit", tone: "blue" },
  arrived: { label: "Arrived", tone: "green" },
  delivered: { label: "Delivered", tone: "violet" },
  // POs
  open: { label: "Open", tone: "blue" },
  partially_received: { label: "Partially received", tone: "amber" },
  received: { label: "Received", tone: "green" },
  closed: { label: "Closed", tone: "neutral" },
  // documents
  pending: { label: "Pending", tone: "neutral" },
  processing: { label: "Processing", tone: "blue" },
  processed: { label: "Processed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  // parts (draft shared with entries above)
  active: { label: "Active", tone: "green" },
  archived: { label: "Archived", tone: "neutral" },
  pending_changes: { label: "Pending changes", tone: "amber" },
  // quotes ("received"/"rejected" reuse rows above where labels differ)
  quote_received: { label: "Received", tone: "blue" },
  approved: { label: "Approved", tone: "amber" },
  applied: { label: "Applied", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  superseded: { label: "Superseded", tone: "neutral" },
  // refunds (derived stage)
  paid: { label: "Paid", tone: "green" },
  pending_payout: { label: "Pending payout", tone: "amber" },
  // review
  confirmed: { label: "Confirmed", tone: "green" },
  accepted: { label: "Accepted", tone: "green" },
  acknowledged: { label: "Acknowledged", tone: "green" },
  // integrations
  paused: { label: "Paused", tone: "neutral" },
  error: { label: "Error", tone: "red" },
  not_configured: { label: "Not configured", tone: "neutral" },
};

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const meta = statusMeta[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Badge
      variant="outline"
      className={cn("font-normal", toneClasses[meta.tone], className)}
    >
      {meta.label}
    </Badge>
  );
}
