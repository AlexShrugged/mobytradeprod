"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { CloudUpload, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type ImportIssue = { row: number | null; message: string };

type ImportSummary = {
  rows: number;
  skus: number;
  created: number;
  updated: number;
  unchanged: number;
  sourcesCreated: number;
  sourcesUpdated: number;
  issues: ImportIssue[];
};

// The Parts page SKU-list import: drop a CSV/XLSX, the server parses and
// applies it in one request, and the result stays up so issues are readable
// before closing. The file lands on the Data page as a processed document.
export function ImportPartsDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [summary, setSummary] = React.useState<ImportSummary | null>(null);
  // 400-with-issues (e.g. no SKU column): show why nothing imported.
  const [failure, setFailure] = React.useState<{
    error: string;
    issues: ImportIssue[];
  } | null>(null);

  const onDrop = React.useCallback(
    async (accepted: File[]) => {
      const file = accepted[0];
      if (!file) return;
      setBusy(true);
      setFailure(null);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/parts/import", {
          method: "POST",
          body: formData,
        });
        const payload = (await res.json().catch(() => null)) as
          | { summary?: ImportSummary; error?: string; issues?: ImportIssue[] }
          | null;
        if (!res.ok || !payload?.summary) {
          const error = payload?.error ?? "The import failed.";
          if (payload?.issues?.length) {
            setFailure({ error, issues: payload.issues });
          } else {
            toast.error(error);
          }
          return;
        }
        setSummary(payload.summary);
        router.refresh();
      } catch {
        toast.error("The import failed.");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    disabled: busy,
    accept: {
      "text/csv": [".csv"],
      "application/vnd.ms-excel": [".csv"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
        ".xlsx",
      ],
    },
  });

  const issues = summary?.issues ?? failure?.issues ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Import parts</DialogTitle>
          <DialogDescription>
            Upload a CSV or XLSX of SKUs. New SKUs are created, existing ones
            updated.
          </DialogDescription>
        </DialogHeader>

        {summary === null ? (
          <div className="flex flex-col gap-3">
            <div
              {...getRootProps()}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors",
                isDragActive
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-muted-foreground/50",
                busy && "cursor-wait opacity-70",
              )}
            >
              <input {...getInputProps()} />
              {busy ? (
                <>
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Importing…</p>
                </>
              ) : (
                <>
                  <CloudUpload className="size-6 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    Drop a file, or click to browse
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Columns detected by header: SKU, Name, Description, HTS
                    Code, Vendor, Country of Origin, Unit Cost
                  </p>
                </>
              )}
            </div>
            {failure !== null ? (
              <p className="text-sm text-destructive">{failure.error}</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {summary.created} created · {summary.updated} updated ·{" "}
              {summary.unchanged} unchanged
              <span className="text-muted-foreground">
                {" "}
                ({summary.rows} row{summary.rows === 1 ? "" : "s"},{" "}
                {summary.skus} SKU{summary.skus === 1 ? "" : "s"})
              </span>
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setSummary(null);
                  setFailure(null);
                }}
              >
                Import another
              </Button>
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        )}

        {issues.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium">
              {issues.length} issue{issues.length === 1 ? "" : "s"}
            </p>
            <ul className="max-h-40 overflow-y-auto rounded-md bg-muted p-2 text-xs text-muted-foreground">
              {issues.map((issue, i) => (
                <li key={i}>
                  {issue.row !== null ? `Row ${issue.row}: ` : ""}
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
