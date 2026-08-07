"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { VendorRow } from "@/lib/db/queries/vendors";

// The vendor roster. Vendors are created implicitly — from documents, quote
// sheets, and the Parts page — so this card only lists and renames. A
// rename touches nothing else: every table references vendors by id, and
// documents keep the supplier name exactly as printed.
export function VendorsCard({ vendors }: { vendors: VendorRow[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  function beginEdit(vendor: VendorRow) {
    setEditingId(vendor.id);
    setDraft(vendor.name);
  }

  async function rename(vendor: VendorRow) {
    const name = draft.trim();
    if (name === "" || name === vendor.name) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/vendors/${vendor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Rename failed.");
      toast.success(`${vendor.name} renamed to ${name}.`);
      setEditingId(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rename failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Vendors</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {vendors.length === 0 ? (
          <p className="text-muted-foreground">
            No vendors yet — they appear as quotes, POs, and invoices name
            them.
          </p>
        ) : (
          <ul className="divide-y">
            {vendors.map((v) => (
              <li key={v.id} className="flex items-center gap-2 py-1.5">
                {editingId === v.id ? (
                  <>
                    <Input
                      value={draft}
                      autoFocus
                      disabled={busy}
                      className="h-7 text-sm"
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void rename(v);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={busy}
                      aria-label="Save vendor name"
                      onClick={() => void rename(v)}
                    >
                      <Check className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={busy}
                      aria-label="Cancel rename"
                      onClick={() => setEditingId(null)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{v.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {v.sourceCount} SKU source
                        {v.sourceCount === 1 ? "" : "s"} · {v.poCount} PO
                        {v.poCount === 1 ? "" : "s"} · {v.quoteSheetCount}{" "}
                        quote{v.quoteSheetCount === 1 ? "" : "s"} ·{" "}
                        {v.invoiceCount} invoice
                        {v.invoiceCount === 1 ? "" : "s"}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground"
                      aria-label={`Rename ${v.name}`}
                      onClick={() => beginEdit(v)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Renaming keeps all SKU sources and document links; documents keep
          the supplier name as printed.
        </p>
      </CardContent>
    </Card>
  );
}
