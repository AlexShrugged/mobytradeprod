// Client-safe vocabulary for duplicate uploads, shared by the upload routes
// (the refusal payload) and the dropzone (the toast). Dependency-free
// beyond the date formatter — it is imported from a client bundle.
import { formatDate } from "@/lib/format";

/** The document a refused upload was identical to. */
export type DuplicateOf = {
  id: string;
  fileName: string;
  uploadedAt: string;
};

/** One refused upload: which file in the request, and what it matched. */
export type DuplicateUpload = {
  index: number;
  fileName: string;
  duplicateOf: DuplicateOf;
};

export function describeDuplicate(existing: DuplicateOf): string {
  return `Identical to ${existing.fileName}, uploaded ${formatDate(existing.uploadedAt)}`;
}

// The batch toast: every skipped file by name, capped so a 15-file re-drag
// does not fill the screen.
export function summarizeDuplicates(duplicates: DuplicateUpload[]): string {
  const n = duplicates.length;
  if (n === 0) return "";
  const shown = duplicates.slice(0, 3).map((d) => d.fileName);
  const rest = n - shown.length;
  const list =
    rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
  return n === 1
    ? `Skipped ${list}: ${describeDuplicate(duplicates[0].duplicateOf).replace(/^Identical/, "identical")}.`
    : `Skipped ${n} duplicates already on file: ${list}.`;
}
