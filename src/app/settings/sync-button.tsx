"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

// "Sync now": POST /api/tariff-sync, then summarize all three parts (Ch99
// staging, Federal Register, base refresh). The parts fail independently,
// so partial failures render as warnings inside an otherwise-successful
// toast.
export function SyncButton() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function sync() {
    setBusy(true);
    const toastId = toast.loading("Syncing tariff data from USITC…");
    try {
      const res = await fetch("/api/tariff-sync", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Sync failed.");

      const parts: string[] = [];
      let failures = 0;
      const usitc = body?.usitc;
      if (usitc?.error) {
        failures += 1;
        parts.push(`Ch99: ${usitc.error}`);
      } else if (usitc?.unchanged) {
        parts.push("Ch99: no changes");
      } else {
        parts.push(`Ch99: ${usitc?.staged ?? 0} revision(s) staged for review`);
      }
      const base = body?.base;
      if (base?.error) {
        failures += 1;
        parts.push(`Base: ${base.error}`);
      } else if (base) {
        parts.push(
          `Base ${base.release}: ${base.added} added, ${base.changed} changed, ${base.removed} removed`,
        );
      }
      const fr = body?.federalRegister;
      if (fr?.error) {
        failures += 1;
        parts.push(`Federal Register: ${fr.error}`);
      } else {
        parts.push(`Federal Register: ${fr?.created ?? 0} new notice(s)`);
      }

      const message = parts.join(" · ");
      if (failures === parts.length) toast.error(message, { id: toastId });
      else if (failures > 0) toast.warning(message, { id: toastId });
      else toast.success(message, { id: toastId });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed.", {
        id: toastId,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={sync} disabled={busy} variant="outline" size="sm">
      <RefreshCw className={busy ? "animate-spin" : ""} />
      {busy ? "Syncing…" : "Sync now"}
    </Button>
  );
}
