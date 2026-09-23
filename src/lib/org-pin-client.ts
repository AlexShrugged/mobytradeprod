"use client";

import { toast } from "sonner";

import {
  ORG_PIN_ATTRIBUTE,
  ORG_PIN_HEADER,
  ORG_PIN_MISMATCH_CODE,
  ORG_PIN_MISMATCH_MESSAGE,
} from "./org-pin";

// Browser side of the organization pin (see org-pin.ts). Every client
// component talks to /api through apiFetch so each call names the org the
// page rendered under; a 409 org_mismatch means another tab switched the
// session's organization, and the only right move is a reload.

/** The Clerk org id the current page rendered under, or null (auth-open
 *  dev, signed-out chrome, server render). */
export function pinnedOrgId(): string | null {
  if (typeof document === "undefined") return null;
  const value = document.body?.getAttribute(ORG_PIN_ATTRIBUTE);
  return value ? value : null;
}

/** Headers to spread into a request the browser makes outside apiFetch
 *  (the Vercel Blob client upload, which posts to our token route itself). */
export function orgPinHeaders(): Record<string, string> {
  const pin = pinnedOrgId();
  return pin ? { [ORG_PIN_HEADER]: pin } : {};
}

const RELOAD_TOAST_ID = "org-pin-mismatch";

export function notifyOrgMismatch(): void {
  toast.error(ORG_PIN_MISMATCH_MESSAGE, {
    id: RELOAD_TOAST_ID,
    duration: Infinity,
    action: { label: "Reload", onClick: () => window.location.reload() },
  });
}

/** fetch() with the organization pin attached. Returns the response
 *  untouched (callers keep their own error handling); a 409 org_mismatch
 *  additionally raises the reload toast. */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const pin = pinnedOrgId();
  if (pin && !headers.has(ORG_PIN_HEADER)) headers.set(ORG_PIN_HEADER, pin);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 409) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { code?: string } | null;
    if (body?.code === ORG_PIN_MISMATCH_CODE) notifyOrgMismatch();
  }
  return res;
}
