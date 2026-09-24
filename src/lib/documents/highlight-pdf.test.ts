import { PDFDocument, degrees } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { boxToRect, highlightPage } from "./highlight-pdf";

const frame = { x: 0, y: 0, width: 612, height: 792, rotation: 0 };
// A box a fifth of the way across, a tenth of the way down, spanning half
// the width and a twentieth of the height of the DISPLAYED page.
const box = { page: 1, left: 0.2, top: 0.1, width: 0.5, height: 0.05 };

describe("boxToRect", () => {
  it("flips the top-left origin to PDF's bottom-left on an unrotated page", () => {
    const rect = boxToRect(box, frame);
    expect(rect.x).toBeCloseTo(122.4);
    expect(rect.y).toBeCloseTo(792 - (0.1 + 0.05) * 792);
    expect(rect.width).toBeCloseTo(306);
    expect(rect.height).toBeCloseTo(39.6);
  });

  it("offsets by the crop box origin", () => {
    const rect = boxToRect(box, { ...frame, x: 10, y: 20 });
    expect(rect.x).toBeCloseTo(132.4);
    expect(rect.y).toBeCloseTo(20 + 792 - (0.1 + 0.05) * 792);
  });

  it("turns a /Rotate 90 page's box back into unrotated space", () => {
    // Displayed: 792 wide, 612 tall. The displayed top-left corner is the
    // unrotated bottom-left, so a box near the displayed top-left lands
    // near x=0, y=0 with its axes swapped.
    const rect = boxToRect(box, { ...frame, rotation: 90 });
    expect(rect).toEqual({
      x: 0.1 * 612,
      y: 0.2 * 792,
      width: 0.05 * 612,
      height: 0.5 * 792,
    });
  });

  it("turns a /Rotate 180 page's box back", () => {
    const rect = boxToRect(box, { ...frame, rotation: 180 });
    expect(rect).toEqual({
      x: (1 - 0.2 - 0.5) * 612,
      y: 0.1 * 792,
      width: 0.5 * 612,
      height: 0.05 * 792,
    });
  });

  it("turns a /Rotate 270 page's box back", () => {
    const rect = boxToRect(box, { ...frame, rotation: 270 });
    expect(rect).toEqual({
      x: (1 - 0.1 - 0.05) * 612,
      y: (1 - 0.2 - 0.5) * 792,
      width: 0.05 * 612,
      height: 0.5 * 792,
    });
  });

  it("clamps a box that overruns the page", () => {
    const rect = boxToRect(
      { page: 1, left: 0.9, top: 0.95, width: 0.5, height: 0.5 },
      frame,
    );
    expect(rect.x + rect.width).toBeCloseTo(612);
    expect(rect.y).toBeCloseTo(0);
  });
});

async function twoPageDocument(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const first = doc.addPage([612, 792]);
  first.drawText("page one", { x: 50, y: 700 });
  const second = doc.addPage([612, 792]);
  second.drawText("page two", { x: 50, y: 700 });
  second.setRotation(degrees(90));
  return doc.save();
}

describe("highlightPage", () => {
  it("slices out the one page, keeping its size and rotation", async () => {
    const out = await highlightPage(await twoPageDocument(), 2, [
      { page: 2, left: 0.1, top: 0.1, width: 0.3, height: 0.05 },
      // A box on another page is ignored, never an error.
      { page: 1, left: 0.1, top: 0.1, width: 0.3, height: 0.05 },
    ]);
    const result = await PDFDocument.load(out);
    expect(result.getPageCount()).toBe(1);
    const page = result.getPage(0);
    expect(page.getSize()).toEqual({ width: 612, height: 792 });
    expect(page.getRotation().angle).toBe(90);
  });

  it("refuses a page the document does not have", async () => {
    await expect(highlightPage(await twoPageDocument(), 3, [])).rejects.toThrow(
      RangeError,
    );
    await expect(highlightPage(await twoPageDocument(), 0, [])).rejects.toThrow(
      RangeError,
    );
  });
});
