import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { getCurrentOrg } from "@/lib/org";

const bodySchema = z
  .object({
    name: z.string().trim().min(1, "Name cannot be empty.").max(200).optional(),
    importerOfRecord: z.string().trim().max(200).nullish(),
  })
  .refine(
    (d) => d.name !== undefined || d.importerOfRecord !== undefined,
    "Nothing to update.",
  );

// Update the single org row (name, importer of record). The inbox address
// is read-only — it is provisioned with the intake channel, not edited.
export async function PATCH(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: z.prettifyError(parsed.error) },
      { status: 400 },
    );
  }

  const org = await getCurrentOrg();
  const patch: Partial<typeof schema.orgs.$inferInsert> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.importerOfRecord !== undefined) {
    patch.importerOfRecord = parsed.data.importerOfRecord || null;
  }

  const [updated] = await db
    .update(schema.orgs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.orgs.id, org.id))
    .returning();

  return NextResponse.json({ org: updated });
}
