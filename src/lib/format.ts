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

/** Digits-normalized dotted HTS rendering: "8714949000" or "8714.94.90.00"
 *  → "8714.94.9000"; 8-digit Chapter 99 codes → "9903.88.01". */
export function formatHts(code: string | null | undefined): string {
  if (!code) return "—";
  const d = code.replace(/\D/g, "");
  if (d.length < 6) return code;
  const parts = [d.slice(0, 4), d.slice(4, 6)];
  if (d.length > 6) parts.push(d.slice(6, 10));
  return parts.join(".");
}

const docTypeLabels: Record<string, string> = {
  port_entry: "Port entry",
  cargo_release: "Cargo release",
  shipment: "Shipment",
  purchase_order: "Purchase order",
  commercial_invoice: "Commercial invoice",
  packing_list: "Packing list",
  quote_sheet: "Quote sheet",
  refund_report: "Refund report",
  entry_packet: "Entry packet",
  part_catalog: "Part catalog",
  other: "Other",
};

export function docTypeLabel(type: string): string {
  return docTypeLabels[type] ?? type;
}
