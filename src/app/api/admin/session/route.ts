import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ADMIN_COOKIE } from "@/lib/admin";
import { secretMatches } from "@/lib/admin/access";

// Super-admin cookie login. With SUPER_ADMIN_SECRET unset (local dev) the
// gate is open and there is nothing to unlock — POST is a friendly no-op so
// the lock form never wedges a dev environment.
export async function POST(request: Request) {
  const envSecret = process.env.SUPER_ADMIN_SECRET;
  if (!envSecret) return NextResponse.json({ ok: true, open: true });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = z.object({ secret: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { secret }." }, { status: 400 });
  }
  if (!secretMatches(parsed.data.secret, envSecret)) {
    return NextResponse.json({ error: "Wrong secret." }, { status: 403 });
  }

  const jar = await cookies();
  jar.set(ADMIN_COOKIE, parsed.data.secret, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete(ADMIN_COOKIE);
  return NextResponse.json({ ok: true });
}
