// Loads everything the savings analyst may reach for one part, up front:
// the catalog part with its classification and sourcing windows, and the
// part's entry-line history (trailing ~12 months) with declared duty
// charges — the annualized basis candidates are priced against. Read-only.
//
// Relative imports + DbClient parameter on purpose — runs under tsx.

import { and, eq } from "drizzle-orm";

import * as schema from "../../db/schema";
import type { DbClient } from "../../duty/reference";
import type { PartBundle, SavingsHistoryLine } from "./types";

const DUTY_CHARGE_TYPES = new Set([
  "base_duty",
  "additional_duty",
  "antidumping",
  "countervailing",
]);

export async function loadPartBundle(
  db: DbClient,
  orgId: string,
  partId: string,
): Promise<PartBundle | null> {
  const part = await db.query.parts.findFirst({
    where: and(eq(schema.parts.id, partId), eq(schema.parts.orgId, orgId)),
    with: {
      classifications: true,
      sources: { with: { vendor: true } },
    },
  });
  if (!part) return null;

  const cutoff = new Date(Date.now() - 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const lines = await db.query.entryLineItems.findMany({
    where: and(
      eq(schema.entryLineItems.orgId, orgId),
      eq(schema.entryLineItems.partId, partId),
    ),
    with: {
      entry: { columns: { entryNumber: true, entryDate: true } },
      charges: true,
    },
  });

  const history: SavingsHistoryLine[] = lines
    .filter((li) => li.entry.entryDate === null || li.entry.entryDate >= cutoff)
    .sort((a, b) =>
      (b.entry.entryDate ?? "").localeCompare(a.entry.entryDate ?? ""),
    )
    .map((li) => ({
      entryNumber: li.entry.entryNumber,
      entryDate: li.entry.entryDate,
      lineNumber: li.lineNumber,
      htsCode: li.htsCode,
      countryOfOrigin: li.countryOfOrigin,
      quantity: li.quantity,
      enteredValue: li.enteredValue,
      dutyCharges: li.charges
        .filter((c) => DUTY_CHARGE_TYPES.has(c.chargeType))
        .map((c) => ({
          chargeType: c.chargeType,
          rate: c.rate,
          amount: c.amount,
        })),
    }));

  const trailingEnteredValueCents = history.reduce(
    (sum, l) => sum + Math.round(Number(l.enteredValue) * 100),
    0,
  );
  const countriesOfOrigin = [
    ...new Set(
      [
        ...part.sources.map((s) => s.countryOfOrigin),
        ...history.map((l) => l.countryOfOrigin),
      ].filter((c): c is string => c !== null),
    ),
  ].sort();

  return {
    orgId,
    part: {
      id: part.id,
      sku: part.sku,
      name: part.name,
      description: part.description,
      status: part.status,
      htsCode: part.htsCodeProvisional ? null : part.htsCode,
      htsCodeProvisional: part.htsCodeProvisional,
      classifications: part.classifications.map((c) => ({
        htsCode: c.htsCode,
        validFrom: c.validFrom,
        validTo: c.validTo,
      })),
      sources: part.sources.map((s) => ({
        vendorName: s.vendor.name,
        countryOfOrigin: s.countryOfOrigin,
        unitCost: s.unitCost,
        validFrom: s.validFrom,
        validTo: s.validTo,
      })),
    },
    history,
    trailingEnteredValueCents,
    countriesOfOrigin,
  };
}
