"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { UploadDropzone } from "@/components/data/upload-dropzone";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Two ways into the catalog:
//  - Manual: a human typing the entry IS the approval → active part.
//  - From quote, itself two ways: upload the vendor's quote sheet (the
//    document pipeline parses it and ingests its lines), or type it in —
//    which goes through POST /api/quote-sheets, the same path uploaded
//    sheets take. Either way an unknown SKU becomes a DRAFT part pending
//    approval.
// Reached pre-filled from a part row's "Add quote" (presetSku fixes the SKU
// and hides the manual tab — you are quoting an existing part).
export function NewSkuDialog({
  presetSku,
  onClose,
}: {
  presetSku: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  // Manual tab.
  const [sku, setSku] = React.useState("");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [origin, setOrigin] = React.useState("");
  const [vendorName, setVendorName] = React.useState("");
  const [unitCost, setUnitCost] = React.useState("");
  const [vendorNames, setVendorNames] = React.useState<string[]>([]);

  // Known vendors feed the datalists on both tabs.
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/vendors")
      .then(async (res) => {
        if (!res.ok) return;
        const payload = (await res.json()) as { vendors: { name: string }[] };
        if (!cancelled) setVendorNames(payload.vendors.map((v) => v.name));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Quote tab.
  const [supplier, setSupplier] = React.useState("");
  const [quoteDate, setQuoteDate] = React.useState("");
  const [qSku, setQSku] = React.useState(presetSku ?? "");
  const [qDescription, setQDescription] = React.useState("");
  const [qUnitCost, setQUnitCost] = React.useState("");
  const [qOrigin, setQOrigin] = React.useState("");
  const [qHts, setQHts] = React.useState("");
  const [qMoq, setQMoq] = React.useState("");
  const [qLeadTime, setQLeadTime] = React.useState("");

  async function post(url: string, body: unknown): Promise<unknown> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (!res.ok) throw new Error(payload?.error ?? "The request failed.");
    return payload;
  }

  async function submitManual() {
    const cost = unitCost.trim() === "" ? null : Number(unitCost);
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) {
      toast.error("Cost/unit must be a non-negative number.");
      return;
    }
    if ((origin.trim() || cost !== null) && vendorName.trim() === "") {
      toast.error("Name the vendor to set origin and cost.");
      return;
    }
    setBusy(true);
    try {
      await post("/api/parts", {
        sku: sku.trim(),
        name: name.trim(),
        description: description.trim() || null,
        vendorName: vendorName.trim() || null,
        countryOfOrigin: origin.trim() || null,
        unitCost: cost,
      });
      toast.success(`SKU ${sku.trim()} created.`);
      router.refresh();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Creating the SKU failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitQuote() {
    const cost = Number(qUnitCost);
    if (!Number.isFinite(cost) || cost < 0) {
      toast.error("Cost/unit must be a non-negative number.");
      return;
    }
    const moq = qMoq.trim() === "" ? null : Number(qMoq);
    if (moq !== null && (!Number.isFinite(moq) || moq < 0)) {
      toast.error("MOQ must be a non-negative number.");
      return;
    }
    const leadTime = qLeadTime.trim() === "" ? null : Number(qLeadTime);
    if (leadTime !== null && (!Number.isInteger(leadTime) || leadTime < 0)) {
      toast.error("Lead time must be a non-negative whole number of days.");
      return;
    }
    setBusy(true);
    try {
      const result = (await post("/api/quote-sheets", {
        supplierName: supplier.trim() || null,
        quoteDate: quoteDate || null,
        lines: [
          {
            lineNumber: 1,
            sku: qSku.trim(),
            description: qDescription.trim() || null,
            unitCost: cost,
            countryOfOrigin: qOrigin.trim() || null,
            htsCode: qHts.trim() || null,
            moq,
            leadTimeDays: leadTime,
          },
        ],
      })) as { createdPartIds?: string[] };
      toast.success(
        (result.createdPartIds?.length ?? 0) > 0
          ? `Quote recorded. ${qSku.trim()} created as a draft SKU.`
          : `Quote recorded for ${qSku.trim()}.`,
      );
      router.refresh();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Recording the quote failed.");
    } finally {
      setBusy(false);
    }
  }

  const quoteForm = (
    <div className="flex flex-col gap-3">
      <UploadDropzone
        variant="compact"
        onComplete={(allSucceeded) => {
          if (allSucceeded) onClose();
        }}
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Separator className="flex-1" />
        or fill it in manually
        <Separator className="flex-1" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="quote-supplier" label="Vendor">
          <Input
            id="quote-supplier"
            list="quote-vendors"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder={vendorNames[0] ?? "Vendor name"}
          />
          <datalist id="quote-vendors">
            {vendorNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </Field>
        <Field id="quote-date" label="Quote date">
          <Input
            id="quote-date"
            type="date"
            value={quoteDate}
            onChange={(e) => setQuoteDate(e.target.value)}
          />
        </Field>
        <Field id="quote-sku" label="SKU">
          <Input
            id="quote-sku"
            value={qSku}
            onChange={(e) => setQSku(e.target.value)}
            disabled={presetSku !== null}
            className="tabular-nums"
          />
        </Field>
        <Field id="quote-cost" label="Cost/unit">
          <Input
            id="quote-cost"
            type="number"
            step="0.01"
            min="0"
            value={qUnitCost}
            onChange={(e) => setQUnitCost(e.target.value)}
            className="tabular-nums"
          />
        </Field>
      </div>
      <Field id="quote-description" label="Description">
        <Input
          id="quote-description"
          value={qDescription}
          onChange={(e) => setQDescription(e.target.value)}
          placeholder="As printed on the sheet"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="quote-origin" label="Origin (2-letter)">
          <Input
            id="quote-origin"
            value={qOrigin}
            onChange={(e) => setQOrigin(e.target.value)}
            placeholder="CN"
            maxLength={2}
          />
        </Field>
        <Field id="quote-hts" label="HTS (supplier reference)">
          <Input
            id="quote-hts"
            value={qHts}
            onChange={(e) => setQHts(e.target.value)}
            placeholder="8714.94.9000"
            className="tabular-nums"
          />
        </Field>
        <Field id="quote-moq" label="MOQ">
          <Input
            id="quote-moq"
            type="number"
            min="0"
            value={qMoq}
            onChange={(e) => setQMoq(e.target.value)}
            className="tabular-nums"
          />
        </Field>
        <Field id="quote-leadtime" label="Lead time (days)">
          <Input
            id="quote-leadtime"
            type="number"
            min="0"
            step="1"
            value={qLeadTime}
            onChange={(e) => setQLeadTime(e.target.value)}
            className="tabular-nums"
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy || qSku.trim() === "" || qUnitCost.trim() === ""}
          onClick={submitQuote}
        >
          Record quote
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">
            {presetSku === null ? "New SKU" : `Add quote: ${presetSku}`}
          </DialogTitle>
          <DialogDescription>
            {presetSku === null
              ? "Create a SKU manually or record a vendor quote."
              : "Upload the vendor's quote sheet or enter it below."}
          </DialogDescription>
        </DialogHeader>

        {presetSku !== null ? (
          quoteForm
        ) : (
          <Tabs defaultValue="manual">
            <TabsList>
              <TabsTrigger value="manual">Manual</TabsTrigger>
              <TabsTrigger value="quote">From quote</TabsTrigger>
            </TabsList>

            <TabsContent value="manual" className="mt-3">
              <div className="flex flex-col gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="new-sku" label="SKU">
                    <Input
                      id="new-sku"
                      value={sku}
                      onChange={(e) => setSku(e.target.value)}
                      placeholder="e.g. SKU-0001"
                      className="tabular-nums"
                    />
                  </Field>
                  <Field id="new-name" label="Name">
                    <Input
                      id="new-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Part name"
                    />
                  </Field>
                </div>
                <Field id="new-description" label="Description">
                  <Input
                    id="new-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field id="new-vendor" label="Vendor">
                    <Input
                      id="new-vendor"
                      list="new-sku-vendors"
                      value={vendorName}
                      onChange={(e) => setVendorName(e.target.value)}
                      placeholder={vendorNames[0] ?? "Vendor name"}
                    />
                    <datalist id="new-sku-vendors">
                      {vendorNames.map((n) => (
                        <option key={n} value={n} />
                      ))}
                    </datalist>
                  </Field>
                  <Field id="new-origin" label="Origin (2-letter)">
                    <Input
                      id="new-origin"
                      value={origin}
                      onChange={(e) => setOrigin(e.target.value)}
                      placeholder="CN"
                      maxLength={2}
                    />
                  </Field>
                  <Field id="new-cost" label="Cost/unit">
                    <Input
                      id="new-cost"
                      type="number"
                      step="0.01"
                      min="0"
                      value={unitCost}
                      onChange={(e) => setUnitCost(e.target.value)}
                      className="tabular-nums"
                    />
                  </Field>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" disabled={busy} onClick={onClose}>
                    Cancel
                  </Button>
                  <Button
                    disabled={busy || sku.trim() === "" || name.trim() === ""}
                    onClick={submitManual}
                  >
                    Create SKU
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="quote" className="mt-3">
              {quoteForm}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}
