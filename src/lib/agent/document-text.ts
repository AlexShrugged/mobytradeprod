// Raw document text for the assistant: slices Reducto's stored parse
// payload (documents.raw_extraction -> parse.result.chunks[]) into paged,
// capped text. First and only consumer of the raw corpus. Defensive over
// unknown - provider payload shapes are not under our control. Pure.

const MAX_TEXT_CHARS = 20_000;

type RawChunk = { content: string; pages: number[] };

export type DocumentTextResult =
  | {
      ok: true;
      /** Chunk count AFTER the page filter — the cursor space. */
      totalChunks: number;
      /** Every page number seen across the whole document's chunks. */
      pagesAvailable: number[];
      text: string;
      /** Pass back to continue reading; null when done. Only meaningful
       *  with the same page filter. */
      nextCursor: number | null;
    }
  | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** parse.result.chunks[] -> {content, pages[]}; [] when the payload has no
 *  readable chunks (stub-processed, or a shape we don't recognize). */
function readChunks(raw: unknown): RawChunk[] {
  if (!isRecord(raw)) return [];
  const parse = raw.parse;
  if (!isRecord(parse)) return [];
  const result = parse.result;
  if (!isRecord(result)) return [];
  const chunks = result.chunks;
  if (!Array.isArray(chunks)) return [];
  const out: RawChunk[] = [];
  for (const chunk of chunks) {
    if (!isRecord(chunk) || typeof chunk.content !== "string") continue;
    const pages = new Set<number>();
    if (Array.isArray(chunk.blocks)) {
      for (const block of chunk.blocks) {
        if (!isRecord(block)) continue;
        const bbox = block.bbox;
        if (isRecord(bbox) && typeof bbox.page === "number") {
          pages.add(bbox.page);
        }
      }
    }
    out.push({ content: chunk.content, pages: [...pages].sort((a, b) => a - b) });
  }
  return out;
}

export function extractDocumentText(
  raw: unknown,
  opts: { page: number | null; cursor: number | null; maxChars?: number },
): DocumentTextResult {
  const all = readChunks(raw);
  if (all.length === 0) {
    return {
      ok: false,
      error:
        "no parsed text stored for this document (stub-processed, or parsing has not run)",
    };
  }
  const pagesAvailable = [
    ...new Set(all.flatMap((c) => c.pages)),
  ].sort((a, b) => a - b);
  const filtered =
    opts.page === null
      ? all
      : all.filter((c) => c.pages.includes(opts.page as number));
  if (filtered.length === 0) {
    return {
      ok: false,
      error: `no text on page ${opts.page}. Pages with text: ${pagesAvailable.join(", ")}`,
    };
  }
  const maxChars = opts.maxChars ?? MAX_TEXT_CHARS;
  const start = Math.max(0, opts.cursor ?? 0);
  if (start >= filtered.length) {
    return {
      ok: false,
      error: `cursor ${start} is past the end (${filtered.length} chunks under this page filter)`,
    };
  }
  const parts: string[] = [];
  let used = 0;
  let index = start;
  while (index < filtered.length) {
    const piece = filtered[index].content;
    if (parts.length > 0 && used + piece.length > maxChars) break;
    parts.push(piece);
    used += piece.length;
    index += 1;
    if (used >= maxChars) break;
  }
  let text = parts.join("\n\n");
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n[chunk truncated - continue with cursor ${index}]`;
  }
  return {
    ok: true,
    totalChunks: filtered.length,
    pagesAvailable,
    text,
    nextCursor: index < filtered.length ? index : null,
  };
}
