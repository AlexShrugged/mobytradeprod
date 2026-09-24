import { PDFDocument, rgb } from "pdf-lib";

import type { SourceBox } from "@/lib/processing/types";

// One page of a stored PDF with cited boxes highlighted, for the browser's
// own viewer to show. Pure over bytes: no IO, nothing stored.
//
// Reducto's boxes are normalized to the page as DISPLAYED — [0, 1] of the
// rendered width and height, origin top-left, rotation already applied. PDF
// user space is the UNROTATED page with its origin bottom-left, and the
// crop box (what viewers show) need not start at 0,0. boxToRect undoes both:
// a scanned landscape page carrying /Rotate 90 gets its box turned back
// before it is drawn.

export type PageFrame = {
  /** The crop box in user space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The page's /Rotate, degrees clockwise (0, 90, 180, 270). */
  rotation: number;
};

export type Rect = { x: number; y: number; width: number; height: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function boxToRect(box: SourceBox, frame: PageFrame): Rect {
  const left = clamp01(box.left);
  const top = clamp01(box.top);
  const width = Math.min(clamp01(box.width), 1 - left);
  const height = Math.min(clamp01(box.height), 1 - top);
  const { x, y, width: W, height: H } = frame;
  switch ((((frame.rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270) {
    // Displayed top edge is the unrotated left edge: the box's vertical
    // extent runs along x, its horizontal extent along y.
    case 90:
      return {
        x: x + top * W,
        y: y + left * H,
        width: height * W,
        height: width * H,
      };
    case 180:
      return {
        x: x + (1 - left - width) * W,
        y: y + top * H,
        width: width * W,
        height: height * H,
      };
    case 270:
      return {
        x: x + (1 - top - height) * W,
        y: y + (1 - left - width) * H,
        width: height * W,
        height: width * H,
      };
    default:
      return {
        x: x + left * W,
        y: y + (1 - top - height) * H,
        width: width * W,
        height: height * H,
      };
  }
}

/** The one page, sliced out of the document, with every box on it drawn as
 *  a translucent highlight. Throws RangeError when the page is not in the
 *  document; boxes on other pages are ignored. */
export async function highlightPage(
  bytes: Uint8Array,
  page: number,
  boxes: SourceBox[],
  opts: { padding?: number } = {},
): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const count = source.getPageCount();
  if (!Number.isInteger(page) || page < 1 || page > count) {
    throw new RangeError(`Page ${page} is not in the document (1-${count}).`);
  }
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(source, [page - 1]);
  out.addPage(copied);

  const frame: PageFrame = {
    ...copied.getCropBox(),
    rotation: copied.getRotation().angle,
  };
  const pad = opts.padding ?? 3;
  for (const box of boxes) {
    if (box.page !== page) continue;
    const rect = boxToRect(box, frame);
    copied.drawRectangle({
      x: rect.x - pad,
      y: rect.y - pad,
      width: rect.width + 2 * pad,
      height: rect.height + 2 * pad,
      color: rgb(1, 0.84, 0.25),
      opacity: 0.28,
      borderColor: rgb(0.86, 0.6, 0.05),
      borderWidth: 1.2,
      borderOpacity: 0.9,
    });
  }
  return out.save();
}
