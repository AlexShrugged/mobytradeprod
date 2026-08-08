// Pure partitioning of diffed revisions into reviewable units. Wholesale
// adoption stages hundreds of untracked Chapter 99 codes at once; grouping
// create_measure revisions by (authority, 6-digit prefix) turns that flood
// into a handful of family cards ("Adopt 9903.88.xx — Section 301") the
// super admin can reason about, while changes to tracked measures keep
// their per-revision cards and ergonomics.

import type { MeasureAuthorityValue } from "../db/schema";
import { normalizeHts } from "../duty/calculator";
import { AUTHORITY_LABEL } from "./differ";
import type { ProposedRevision } from "./types";

export type RevisionGroupKey = {
  authority: MeasureAuthorityValue;
  ch99Prefix: string; // 6 digits
  title: string;
};

export function groupKeyFor(rev: ProposedRevision): RevisionGroupKey {
  const prefix = normalizeHts(rev.ch99Code).slice(0, 6);
  const dotted = `${prefix.slice(0, 4)}.${prefix.slice(4, 6)}`;
  return {
    authority: rev.authority,
    ch99Prefix: prefix,
    title: `Adopt ${dotted}.xx — ${AUTHORITY_LABEL[rev.authority]}`,
  };
}

export const groupMapKey = (k: Pick<RevisionGroupKey, "authority" | "ch99Prefix">) =>
  `${k.authority}:${k.ch99Prefix}`;

export type PartitionedRevisions = {
  /** create_measure revisions (wholesale adoption), by group map key. */
  grouped: Map<string, { key: RevisionGroupKey; revisions: ProposedRevision[] }>;
  /** Changes to tracked measures — the existing per-revision review path. */
  individual: ProposedRevision[];
};

export function partitionRevisions(
  revisions: ProposedRevision[],
): PartitionedRevisions {
  const grouped: PartitionedRevisions["grouped"] = new Map();
  const individual: ProposedRevision[] = [];

  for (const rev of revisions) {
    if (rev.changeType !== "create_measure") {
      individual.push(rev);
      continue;
    }
    const key = groupKeyFor(rev);
    const mapKey = groupMapKey(key);
    const bucket = grouped.get(mapKey);
    if (bucket) bucket.revisions.push(rev);
    else grouped.set(mapKey, { key, revisions: [rev] });
  }

  return { grouped, individual };
}
