// Usage-based catalog status: a SKU is Active once any entry line has
// carried it, Inactive until then. Derived on read, never stored — and
// distinct from parts.status (draft/active/archived), which tracks the
// catalog record's own lifecycle. Client-safe: the Parts view renders the
// dropdown from this vocabulary and the server query filters by it.

export const PART_USAGE_STATUSES = ["active", "inactive"] as const;
export type PartUsageStatus = (typeof PART_USAGE_STATUSES)[number];

export const PART_STATUS_OPTIONS: {
  status: PartUsageStatus;
  label: string;
  title: string;
}[] = [
  { status: "active", label: "Active", title: "Used in at least one entry" },
  { status: "inactive", label: "Inactive", title: "Never used in an entry" },
];
