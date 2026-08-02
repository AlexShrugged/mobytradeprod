"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Organization identity: name + importer of record, PATCHed to /api/org.
// The inbox address is provisioned with the email intake channel — shown
// read-only here (the Data page owns intake).
export function OrgCard({
  name,
  importerOfRecord,
  inboxAddress,
}: {
  name: string;
  importerOfRecord: string | null;
  inboxAddress: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState({
    name,
    importerOfRecord: importerOfRecord ?? "",
  });
  const dirty =
    draft.name !== name || draft.importerOfRecord !== (importerOfRecord ?? "");

  async function save() {
    if (draft.name.trim() === "") {
      toast.error("Name cannot be empty.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/org", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          importerOfRecord: draft.importerOfRecord.trim() || null,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Update failed.");
      toast.success("Organization updated.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Organization</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="org-name" className="text-xs">
            Name
          </Label>
          <Input
            id="org-name"
            value={draft.name}
            disabled={busy}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="org-ior" className="text-xs">
            Importer of record
          </Label>
          <Input
            id="org-ior"
            value={draft.importerOfRecord}
            placeholder="As filed on the 7501"
            disabled={busy}
            onChange={(e) =>
              setDraft((d) => ({ ...d, importerOfRecord: e.target.value }))
            }
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium">Document inbox</div>
          <div className="text-sm text-muted-foreground">
            {inboxAddress ?? "Not provisioned"}
          </div>
        </div>
        <Button size="sm" onClick={save} disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}
