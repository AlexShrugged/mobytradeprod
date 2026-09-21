import "server-only";

import { db } from "@/lib/db";
import type { ResolvedLinePart } from "@/lib/parts/line-parts";
import { loadResolvedLineParts } from "@/lib/parts/line-parts-load";

// Which catalog parts sit behind each 7501 line, on the request path. The
// loader itself lives in parts/line-parts-load.ts (DbClient parameter) so
// the analyst bundle shares it.
export function getResolvedLinePartsForEntries(
  entryIds: string[],
): Promise<Map<string, ResolvedLinePart[]>> {
  return loadResolvedLineParts(db, entryIds);
}
