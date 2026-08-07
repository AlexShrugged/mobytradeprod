import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import {
  renameVendor,
  VendorNameConflictError,
} from "@/lib/vendors/service";

const bodySchema = z.object({
  name: z.string().trim().min(1, "Vendor name is required"),
});

// Rename only. Safe by construction: everything references the vendor by
// id, and documents keep the supplier name exactly as printed. No delete —
// vendors accrete from documents and merging is future work.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ vendorId: string }> },
) {
  const { vendorId } = await params;
  const orgId = await getCurrentOrgId();

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

  try {
    const vendor = await renameVendor(db, orgId, vendorId, parsed.data.name);
    if (!vendor) {
      return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    }
    return NextResponse.json({ vendor });
  } catch (err) {
    if (err instanceof VendorNameConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
