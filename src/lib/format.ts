export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(`${value}T00:00:00`) : value;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMoney(
  value: string | number | null | undefined,
  currency = "USD",
): string {
  if (value == null) return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency });
}

/** Integer cents → "$1,234.56". The landed-cost layer works in cents. */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return formatMoney(cents / 100);
}

// Duty rates are decimal fractions (0.25 = 25%). Numerics arrive from
// drizzle as strings.
export function formatRate(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return "—";
  const pct = n * 100;
  const rounded = Math.round(pct * 10000) / 10000;
  return `${rounded}%`;
}

const docTypeLabels: Record<string, string> = {
  port_entry: "Port entry",
  shipment: "Shipment",
  purchase_order: "Purchase order",
  commercial_invoice: "Commercial invoice",
  packing_list: "Packing list",
  quote_sheet: "Quote sheet",
  refund_report: "Refund report",
  other: "Other",
};

export function docTypeLabel(type: string): string {
  return docTypeLabels[type] ?? type;
}
