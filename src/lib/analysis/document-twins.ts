// The analyst never sees the same bytes twice. Upload dedupe refuses a file
// identical to one already in the org (documents.content_hash), but the
// twins that got in before hashing existed — or raced the check — still hang
// on the entry graph as separate documents, each with its own extraction,
// and two extractions of one PDF can disagree: an August run took a 7501's
// Block 33 gross weight for the net quantity and the house bill for the part
// number, the later run read both right, and the analyst, handed both as
// "two prints", reported the disagreement as a document inconsistency on the
// entry and on two siblings (ASC 231-7354575-4, "MobyTrade Part 2 (5)/(8)
// .pdf", found 2026-09-24). Only one print exists. So the bundle collapses
// byte-identical uploads to ONE copy before the analyst looks — the copy the
// entry graph was last written from (the processing that ran last wrote the
// entry's lines last) — and names the other uploads on it. Packet children
// carry no hash of their own; they collapse with their parent's family.
//
// This is a different question from the Data page's Duplicate badge, which
// names the EARLIER upload as the original: the ledger describes uploads,
// the bundle describes which extraction the entry's facts came from.
//
// Pure. The bundle loader applies the verdict.

export type TwinDocument = {
  id: string;
  fileName: string;
  status: string;
  parentDocumentId: string | null;
  contentHash: string | null;
  processedAt: Date | null;
  uploadedAt: Date;
};

/** A packet parent referenced by a bundle child. Parents create no domain
 *  links, so they are never bundle documents themselves; the loader fetches
 *  them for their hash. */
export type TwinParent = {
  id: string;
  fileName: string;
  status: string;
  contentHash: string | null;
  processedAt: Date | null;
  uploadedAt: Date;
};

export type SameBytesAs = { id: string; fileName: string };

export type CollapsedUpload = {
  /** The document dropped from the bundle. */
  id: string;
  fileName: string;
  /** The surviving family's bundle documents, to read instead. */
  keptIds: string[];
};

export type TwinCollapse = {
  keptIds: Set<string>;
  /** Kept document id → the other uploads of the same bytes: the dropped
   *  standalone twin, or the dropped packet file for a packet child. Only
   *  documents that have twins appear. */
  sameBytesAs: Map<string, SameBytesAs[]>;
  collapsed: CollapsedUpload[];
};

type Root = {
  id: string;
  fileName: string;
  status: string;
  contentHash: string | null;
  processedAt: Date | null;
  uploadedAt: Date;
};

// The survivor among twins: a processed copy over a failed or pending one,
// then the copy processed last (it wrote the entry graph last), then the
// later upload, then the later id — total, so the choice is stable.
function survivorFirst(a: Root, b: Root): number {
  const pa = a.status === "processed" ? 0 : 1;
  const pb = b.status === "processed" ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const ta = a.processedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const tb = b.processedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (ta !== tb) return tb - ta;
  const ua = a.uploadedAt.getTime();
  const ub = b.uploadedAt.getTime();
  if (ua !== ub) return ub - ua;
  return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
}

export function collapseTwinUploads(
  docs: TwinDocument[],
  parents: Map<string, TwinParent>,
): TwinCollapse {
  // Every document's family root: itself, or its packet parent. A child
  // whose parent is unknown is its own family with no hash — it collapses
  // with nothing.
  const roots = new Map<string, Root>();
  const rootOf = new Map<string, Root>();
  for (const d of docs) {
    const parent = d.parentDocumentId
      ? parents.get(d.parentDocumentId)
      : undefined;
    const candidate: Root = parent
      ? { ...parent }
      : {
          id: d.parentDocumentId ?? d.id,
          fileName: d.fileName,
          status: d.status,
          contentHash: d.parentDocumentId ? null : d.contentHash,
          processedAt: d.processedAt,
          uploadedAt: d.uploadedAt,
        };
    const root = roots.get(candidate.id) ?? candidate;
    roots.set(root.id, root);
    rootOf.set(d.id, root);
  }

  const byHash = new Map<string, Root[]>();
  for (const root of roots.values()) {
    if (!root.contentHash) continue;
    const family = byHash.get(root.contentHash) ?? [];
    family.push(root);
    byHash.set(root.contentHash, family);
  }

  const survivorOf = new Map<string, Root>();
  const twinsOf = new Map<string, SameBytesAs[]>();
  for (const family of byHash.values()) {
    if (family.length < 2) continue;
    const ranked = [...family].sort(survivorFirst);
    const survivor = ranked[0];
    for (const root of ranked) survivorOf.set(root.id, survivor);
    twinsOf.set(
      survivor.id,
      ranked.slice(1).map((r) => ({ id: r.id, fileName: r.fileName })),
    );
  }

  const keptIds = new Set<string>();
  const keptByRoot = new Map<string, string[]>();
  const sameBytesAs = new Map<string, SameBytesAs[]>();
  for (const d of docs) {
    const root = rootOf.get(d.id)!;
    const survivor = survivorOf.get(root.id);
    if (survivor && survivor.id !== root.id) continue;
    keptIds.add(d.id);
    const kept = keptByRoot.get(root.id) ?? [];
    kept.push(d.id);
    keptByRoot.set(root.id, kept);
    const twins = twinsOf.get(root.id);
    if (twins && twins.length > 0) sameBytesAs.set(d.id, twins);
  }
  const collapsed: CollapsedUpload[] = [];
  for (const d of docs) {
    if (keptIds.has(d.id)) continue;
    const survivor = survivorOf.get(rootOf.get(d.id)!.id)!;
    collapsed.push({
      id: d.id,
      fileName: d.fileName,
      keptIds: keptByRoot.get(survivor.id) ?? [],
    });
  }
  return { keptIds, sameBytesAs, collapsed };
}
