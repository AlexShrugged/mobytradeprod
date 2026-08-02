// The one event-type → presentation map, shared by the Events feed and the
// per-SKU history in Parts. Colors lean on the theme's chart tokens so the
// feed reads as one system in both modes.

import {
  Anchor,
  ArrowDownToLine,
  BadgeDollarSign,
  FileCheck2,
  FileText,
  PackagePlus,
  Pencil,
  ReceiptText,
  Ship,
  Stamp,
  Tags,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import type { EventType } from "@/lib/events/types";

export const eventMeta: Record<
  EventType,
  { icon: LucideIcon; label: string; ringClass: string }
> = {
  entry_filed: {
    icon: Stamp,
    label: "Entry",
    ringClass: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  },
  shipment_sailed: {
    icon: Ship,
    label: "Sailed",
    ringClass: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  shipment_arrived: {
    icon: Anchor,
    label: "Arrived",
    ringClass: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  po_placed: {
    icon: FileText,
    label: "PO",
    ringClass: "bg-slate-500/10 text-slate-700 dark:text-slate-400",
  },
  refund_update: {
    icon: BadgeDollarSign,
    label: "Refund",
    ringClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  quote_received: {
    icon: ReceiptText,
    label: "Quote",
    ringClass: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  quote_approved: {
    icon: FileCheck2,
    label: "Quote approved",
    ringClass: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  quote_applied: {
    icon: ArrowDownToLine,
    label: "Cost applied",
    ringClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  part_created: {
    icon: PackagePlus,
    label: "New SKU",
    ringClass: "bg-slate-500/10 text-slate-700 dark:text-slate-400",
  },
  hts_changed: {
    icon: Tags,
    label: "HTS",
    ringClass: "bg-red-500/10 text-red-700 dark:text-red-400",
  },
  cost_changed: {
    icon: Pencil,
    label: "Edit",
    ringClass: "bg-slate-500/10 text-slate-700 dark:text-slate-400",
  },
  tariff_rate_change: {
    icon: TrendingUp,
    label: "Tariff",
    ringClass: "bg-red-500/10 text-red-700 dark:text-red-400",
  },
};
