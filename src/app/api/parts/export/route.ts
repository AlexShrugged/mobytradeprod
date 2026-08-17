import { and, asc, eq, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import { toCsv } from "@/lib/parts/import-file";

export const dynamic = "force-dynamic";

// The Parts page CSV export: one row per (part, current vendor source), a
// single blank-vendor row for sourceless parts. Column headers round-trip
// through the importer's header mapping, so an exported file re-imports
// cleanly. Status is informational only — the importer ignores it.
export async function GET() {
  const orgId = await getCurrentOrgId();

  const [parts, sources] = await Promise.all([
    db.query.parts.findMany({
      where: eq(schema.parts.orgId, orgId),
      orderBy: asc(schema.parts.sku),
    }),
    db.query.partSources.findMany({
      where: and(
        eq(schema.partSources.orgId, orgId),
        isNull(schema.partSources.validTo),
      ),
      with: { vendor: { columns: { name: true } } },
    }),
  ]);

  const sourcesByPartId = new Map<string, typeof sources>();
  for (const source of sources) {
    const list = sourcesByPartId.get(source.partId) ?? [];
    list.push(source);
    sourcesByPartId.set(source.partId, list);
  }

  const rows: (string | null)[][] = [
    [
      "SKU",
      "Name",
      "Description",
      "HTS Code",
      "Vendor",
      "Country of Origin",
      "Unit Cost",
      "Unit of Measure",
      "Status",
    ],
  ];
  for (const part of parts) {
    const partSources = (sourcesByPartId.get(part.id) ?? []).sort((a, b) =>
      a.vendor.name.localeCompare(b.vendor.name),
    );
    const base = [
      part.sku,
      part.name,
      part.description,
      // A provisional code is a classifier guess, not catalog truth.
      part.htsCodeProvisional ? null : part.htsCode,
    ];
    const tail = [part.unitOfMeasure, part.status];
    if (partSources.length === 0) {
      rows.push([...base, null, null, null, ...tail]);
    } else {
      for (const s of partSources) {
        rows.push([
          ...base,
          s.vendor.name,
          s.countryOfOrigin,
          // numeric(10,4) prints "42.3000" — trim to what a human would type.
          s.unitCost === null ? null : String(Number(s.unitCost)),
          ...tail,
        ]);
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="parts-${today}.csv"`,
    },
  });
}
