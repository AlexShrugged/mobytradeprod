import { NextResponse } from "next/server";

import { getVendors } from "@/lib/db/queries/vendors";

// Vendor list for the Settings card and the vendor-name datalists in the
// Parts dialogs. Creation is implicit (documents, quotes, sources) — there
// is deliberately no POST here.
export async function GET() {
  const vendors = await getVendors();
  return NextResponse.json({ vendors });
}
