"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OrgRule } from "@/lib/db/schema";

// Mirrors SuppressionSpec from lib/org-rules.ts (type-only — that module
// pulls in drizzle and must stay off the client bundle).
type Suppression = {
  alertTypes: string[];
  supplierName: string | null;
  countryOfOrigin: string | null;
  htsPrefix: string | null;
};

type Reaudit = { entries: number; cleared: number; created: number } | null;

// Hand-maintained mirror of the audit_alert_type enum, same invariant as the
// variance page's TYPE_FILTERS: every member appears exactly once.
const ALERT_TYPES: { value: string; label: string }[] = [
  { value: "missing_measure", label: "Missing measure" },
  { value: "unexpected_measure", label: "Unexpected measure" },
  { value: "rate_mismatch", label: "Rate mismatch" },
  { value: "amount_mismatch", label: "Amount mismatch" },
  { value: "hts_discrepancy", label: "HTS discrepancy" },
  { value: "hts_reclassified", label: "HTS reclassified" },
  { value: "coo_discrepancy", label: "COO discrepancy" },
  { value: "value_mismatch", label: "Value mismatch" },
  { value: "quantity_discrepancy", label: "Quantity discrepancy" },
  { value: "data_unreconciled", label: "Data unreconciled" },
  { value: "sail_date_assumption", label: "Sail date assumption" },
  { value: "invoice_hts_mismatch", label: "Invoice HTS mismatch" },
  { value: "invoice_sku_missing", label: "Invoice SKU missing" },
  { value: "invoice_comparison_skipped", label: "Invoice comparison skipped" },
  { value: "unknown_sku", label: "Unknown SKU" },
];

const typeLabel = (value: string) =>
  ALERT_TYPES.find((t) => t.value === value)?.label ?? value;

function scopeSummary(s: Suppression): string {
  const parts = s.alertTypes.map(typeLabel);
  if (s.supplierName) parts.push(`supplier ${s.supplierName}`);
  if (s.countryOfOrigin) parts.push(`origin ${s.countryOfOrigin}`);
  if (s.htsPrefix) parts.push(`HTS ${s.htsPrefix}*`);
  return parts.join(" · ");
}

function changeNote(reaudit: Reaudit, analysesQueued: number): string {
  const bits: string[] = [];
  if (reaudit && reaudit.cleared > 0)
    bits.push(`${reaudit.cleared} alert${reaudit.cleared === 1 ? "" : "s"} cleared`);
  if (reaudit && reaudit.created > 0)
    bits.push(`${reaudit.created} alert${reaudit.created === 1 ? "" : "s"} surfaced`);
  if (analysesQueued > 0)
    bits.push(
      `${analysesQueued} entr${analysesQueued === 1 ? "y" : "ies"} queued for re-analysis`,
    );
  return bits.length > 0 ? ` ${bits.join(", ")}.` : "";
}

export function CustomRulesCard({ rules }: { rules: OrgRule[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [adding, setAdding] = React.useState(false);

  async function call(
    method: "PATCH" | "DELETE",
    ruleId: string,
    body: Record<string, unknown> | null,
    success: (note: string) => string,
  ) {
    setBusy(true);
    try {
      const res = await fetch(`/api/org-rules/${ruleId}`, {
        method,
        ...(body
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? "Update failed.");
      toast.success(
        success(
          changeNote(payload?.reaudit ?? null, payload?.analysesQueued ?? 0),
        ),
      );
      setEditingId(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveText(rule: OrgRule) {
    const text = draft.trim();
    if (text === "" || text === rule.text) {
      setEditingId(null);
      return;
    }
    await call("PATCH", rule.id, { text }, (note) => "Rule updated." + note);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Custom rules</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {rules.length === 0 ? (
          <p className="text-muted-foreground">
            No rules yet. Add one here or ask MobyAI to remember a preference.
          </p>
        ) : (
          <ul className="divide-y">
            {rules.map((rule) => {
              const suppression = rule.suppression as Suppression | null;
              return (
                <li key={rule.id} className="flex items-start gap-3 py-2">
                  <Checkbox
                    checked={rule.enabled}
                    disabled={busy}
                    aria-label={rule.enabled ? "Disable rule" : "Enable rule"}
                    className="mt-0.5"
                    onCheckedChange={(checked) =>
                      void call(
                        "PATCH",
                        rule.id,
                        { enabled: checked === true },
                        (note) =>
                          (checked === true
                            ? "Rule enabled."
                            : "Rule disabled.") + note,
                      )
                    }
                  />
                  {editingId === rule.id ? (
                    <>
                      <Input
                        value={draft}
                        autoFocus
                        disabled={busy}
                        className="h-7 text-sm"
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveText(rule);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={busy}
                        aria-label="Save rule"
                        onClick={() => void saveText(rule)}
                      >
                        <Check className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={busy}
                        aria-label="Cancel edit"
                        onClick={() => setEditingId(null)}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <div
                          className={
                            rule.enabled
                              ? "font-medium"
                              : "font-medium text-muted-foreground"
                          }
                        >
                          {rule.text}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <Badge variant="outline">
                            {suppression ? "Suppression" : "Guidance"}
                          </Badge>
                          {rule.source === "assistant" ? (
                            <Badge variant="outline">MobyAI</Badge>
                          ) : null}
                          {!rule.enabled ? (
                            <Badge variant="outline">Disabled</Badge>
                          ) : null}
                          {suppression ? (
                            <span className="truncate">
                              {scopeSummary(suppression)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground"
                        disabled={busy}
                        aria-label="Edit rule"
                        onClick={() => {
                          setEditingId(rule.id);
                          setDraft(rule.text);
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground"
                        disabled={busy}
                        aria-label="Delete rule"
                        onClick={() =>
                          void call(
                            "DELETE",
                            rule.id,
                            null,
                            (note) => "Rule deleted." + note,
                          )
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3.5" />
          Add rule
        </Button>
      </CardContent>
      {adding ? (
        <AddRuleDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : null}
    </Card>
  );
}

function AddRuleDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [text, setText] = React.useState("");
  const [suppress, setSuppress] = React.useState(false);
  const [alertTypes, setAlertTypes] = React.useState<string[]>([]);
  const [supplierName, setSupplierName] = React.useState("");
  const [countryOfOrigin, setCountryOfOrigin] = React.useState("");
  const [htsPrefix, setHtsPrefix] = React.useState("");

  async function save() {
    const trimmed = text.trim();
    if (!trimmed) {
      toast.error("Rule text is required.");
      return;
    }
    if (suppress && alertTypes.length === 0) {
      toast.error("Pick at least one alert type to suppress.");
      return;
    }
    const suppression = suppress
      ? {
          alertTypes,
          supplierName: supplierName.trim() || null,
          countryOfOrigin: countryOfOrigin.trim() || null,
          htsPrefix: htsPrefix.trim() || null,
        }
      : null;
    setBusy(true);
    try {
      const res = await fetch("/api/org-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, suppression }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? "Save failed.");
      toast.success(
        "Rule saved." +
          changeNote(payload?.reaudit ?? null, payload?.analysesQueued ?? 0),
      );
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add rule</DialogTitle>
          <DialogDescription>
            One sentence. Applied to AI analysis; suppression rules also hide
            matching variance alerts.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rule-text">Rule</Label>
            <Input
              id="rule-text"
              value={text}
              autoFocus
              maxLength={300}
              placeholder="Always check type 03 entries for AD/CVD consistency"
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={suppress}
              onCheckedChange={(v) => setSuppress(v === true)}
            />
            Suppress matching alerts
          </label>
          {suppress ? (
            <div className="space-y-3 rounded-md border p-3">
              <div className="space-y-1.5">
                <Label>Alert types</Label>
                <div className="grid grid-cols-2 gap-1.5">
                  {ALERT_TYPES.map((t) => (
                    <label
                      key={t.value}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={alertTypes.includes(t.value)}
                        onCheckedChange={(v) =>
                          setAlertTypes((prev) =>
                            v === true
                              ? [...prev, t.value]
                              : prev.filter((x) => x !== t.value),
                          )
                        }
                      />
                      {t.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="rule-supplier">Supplier</Label>
                  <Input
                    id="rule-supplier"
                    value={supplierName}
                    placeholder="Any"
                    onChange={(e) => setSupplierName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-coo">Origin</Label>
                  <Input
                    id="rule-coo"
                    value={countryOfOrigin}
                    placeholder="Any"
                    maxLength={2}
                    onChange={(e) => setCountryOfOrigin(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-hts">HTS prefix</Label>
                  <Input
                    id="rule-hts"
                    value={htsPrefix}
                    placeholder="Any"
                    onChange={(e) => setHtsPrefix(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Scope fields combine. Lines without a supplier never match a
                supplier scope.
              </p>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              Save rule
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
