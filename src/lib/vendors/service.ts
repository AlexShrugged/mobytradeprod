// The ONLY writer of the vendors table. Vendors are find-or-created from
// declared supplier names as documents arrive (linker, quotes service) or
// from manual entry (parts/sources routes) — the same auto-create precedent
// POs and shipments follow. Rename is the only edit: it retouches nothing
// else, because every other table references vendors by id and documents
// keep their declared supplier text. No delete, no merge (future work).
//
// Every entry point expects to run inside the caller's transaction where one
// exists (the linker and quote ingestion pass their tx).
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, ne } from "drizzle-orm";

import type { DbClient } from "../db";
import * as schema from "../db/schema";
import { normalizeVendorName } from "./normalize";

/** The route maps this to a 409 — the new name already names another vendor. */
export class VendorNameConflictError extends Error {}

export type ResolvedVendor = {
  id: string;
  name: string;
  created: boolean;
};

/**
 * Resolve a declared supplier name to a vendor row, creating one when the
 * name is new to the org. Returns null when the name normalizes to null
 * (missing/blank supplier on the document) — callers store a null vendor_id
 * and keep whatever declared text they have.
 *
 * The display name keeps the FIRST spelling the org ever saw (trimmed);
 * later variants that normalize identically resolve to the same row without
 * touching it. Rename (Settings) is the way to change the display name.
 */
export async function findOrCreateVendor(
  db: DbClient,
  orgId: string,
  name: string | null | undefined,
): Promise<ResolvedVendor | null> {
  const nameNormalized = normalizeVendorName(name);
  if (nameNormalized === null) return null;

  const existing = await db.query.vendors.findFirst({
    where: and(
      eq(schema.vendors.orgId, orgId),
      eq(schema.vendors.nameNormalized, nameNormalized),
    ),
  });
  if (existing) {
    return { id: existing.id, name: existing.name, created: false };
  }

  const inserted = await db
    .insert(schema.vendors)
    .values({ orgId, name: (name as string).trim(), nameNormalized })
    .onConflictDoNothing({
      target: [schema.vendors.orgId, schema.vendors.nameNormalized],
    })
    .returning();
  if (inserted.length > 0) {
    return { id: inserted[0].id, name: inserted[0].name, created: true };
  }

  // Lost an insert race — the winner's row is the vendor.
  const winner = await db.query.vendors.findFirst({
    where: and(
      eq(schema.vendors.orgId, orgId),
      eq(schema.vendors.nameNormalized, nameNormalized),
    ),
  });
  if (!winner) {
    throw new Error(`Vendor insert for "${nameNormalized}" vanished mid-race`);
  }
  return { id: winner.id, name: winner.name, created: false };
}

/**
 * Rename a vendor. Safe by construction: part_sources, documents, POs,
 * sheets, and field_changes all reference the vendor by id, and declared
 * supplier text on documents is a fact that deliberately keeps the name as
 * printed. Returns null when the vendor doesn't exist (route 404s).
 */
export async function renameVendor(
  db: DbClient,
  orgId: string,
  vendorId: string,
  newName: string,
): Promise<schema.Vendor | null> {
  const name = newName.trim();
  const nameNormalized = normalizeVendorName(name);
  if (nameNormalized === null) {
    throw new VendorNameConflictError("Vendor name cannot be empty.");
  }

  const clash = await db.query.vendors.findFirst({
    where: and(
      eq(schema.vendors.orgId, orgId),
      eq(schema.vendors.nameNormalized, nameNormalized),
      ne(schema.vendors.id, vendorId),
    ),
  });
  if (clash) {
    throw new VendorNameConflictError(
      `Another vendor is already named "${clash.name}".`,
    );
  }

  const [updated] = await db
    .update(schema.vendors)
    .set({ name, nameNormalized, updatedAt: new Date() })
    .where(
      and(eq(schema.vendors.id, vendorId), eq(schema.vendors.orgId, orgId)),
    )
    .returning();
  return updated ?? null;
}
