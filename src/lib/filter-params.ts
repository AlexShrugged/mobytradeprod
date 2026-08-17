// Checkbox-set URL params for the server-filtered list pages (Entries'
// ?phase=, Parts' ?status=). The full set is the default view, so it
// encodes as NO param — unfiltered URLs stay canonical and shareable.
// "none" encodes the empty set (every box unchecked shows nothing, same
// as the variance dropdowns). Client-safe and pure, like pagination.ts,
// so the RSC pages and the client shells can never disagree.

export function parseSetParam<T extends string>(
  raw: string | undefined,
  all: readonly T[],
): Set<T> {
  if (!raw) return new Set(all);
  if (raw === "none") return new Set();
  const picked = raw
    .split(",")
    .filter((v): v is T => (all as readonly string[]).includes(v));
  // Garbage decodes as the default view, same as parsePage.
  return picked.length > 0 ? new Set(picked) : new Set(all);
}

/** Null = omit the param (the default, everything-checked view). */
export function encodeSetParam<T extends string>(
  set: Set<T>,
  all: readonly T[],
): string | null {
  if (set.size >= all.length) return null;
  if (set.size === 0) return "none";
  return all.filter((v) => set.has(v)).join(",");
}
