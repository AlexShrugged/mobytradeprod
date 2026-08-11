"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { useDropzone } from "react-dropzone";
import { CloudUpload, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { buildUploadKey } from "@/lib/documents/upload-key";
import { cn } from "@/lib/utils";
import type { DocumentListItem } from "@/lib/db/schema";

// Blob mode: files go browser → Vercel Blob directly (signed token from
// /api/documents/upload-token), then one register call creates the rows —
// large entry packets never pass through a serverless function body.
// Otherwise: the legacy multipart POST against the local file store.
const BLOB_UPLOADS = process.env.NEXT_PUBLIC_STORAGE_DRIVER === "blob";

async function uploadFiles(accepted: File[]): Promise<DocumentListItem[]> {
  if (!BLOB_UPLOADS) {
    const formData = new FormData();
    for (const file of accepted) formData.append("files", file);
    const res = await fetch("/api/documents/upload", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error("Upload failed.");
    const { documents } = (await res.json()) as {
      documents: DocumentListItem[];
    };
    return documents;
  }

  const CONCURRENCY = 3;
  const queue = [...accepted];
  const uploads: { storageKey: string; fileName: string; mimeType: string }[] =
    [];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const result = await upload(buildUploadKey(file.name), file, {
          access: "public",
          handleUploadUrl: "/api/documents/upload-token",
          multipart: true,
          contentType: file.type || "application/octet-stream",
        });
        uploads.push({
          storageKey: result.pathname,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
        });
      }
    }),
  );
  const res = await fetch("/api/documents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploads }),
  });
  if (!res.ok) throw new Error("Upload failed.");
  const { documents } = (await res.json()) as {
    documents: DocumentListItem[];
  };
  return documents;
}

// full: the Data page hero dropzone. compact: a one-line affordance for
// embedding in dialogs (e.g. quote upload in New SKU).
export function UploadDropzone({
  variant = "full",
}: {
  variant?: "full" | "compact";
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  const onDrop = React.useCallback(
    async (accepted: File[]) => {
      if (accepted.length === 0) return;
      setBusy(`Uploading ${accepted.length} file${accepted.length > 1 ? "s" : ""}…`);
      try {
        const documents = await uploadFiles(accepted);
        router.refresh();

        // Process in a small concurrent pool: real extraction is minutes per
        // document and independent across documents, so the batch takes
        // roughly as long as its slowest doc. The cap keeps provider rate
        // limits and concurrent linker writes at bay.
        const CONCURRENCY = 3;
        const queue = [...documents];
        let done = 0;
        let failed = 0;
        setBusy(`Processing 0 of ${documents.length}…`);
        await Promise.all(
          Array.from(
            { length: Math.min(CONCURRENCY, queue.length) },
            async () => {
              for (let doc = queue.shift(); doc; doc = queue.shift()) {
                const ok = await fetch(`/api/documents/${doc.id}/process`, {
                  method: "POST",
                })
                  .then((res) => res.ok)
                  .catch(() => false);
                if (!ok) failed += 1;
                done += 1;
                setBusy(`Processing ${done} of ${documents.length}…`);
                router.refresh();
              }
            },
          ),
        );

        if (failed > 0) {
          toast.warning(
            `${documents.length - failed} of ${documents.length} documents processed; ${failed} failed. You can reprocess failures from the table.`,
          );
        } else {
          toast.success(
            `${documents.length} document${documents.length > 1 ? "s" : ""} processed.`,
          );
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setBusy(null);
        router.refresh();
      }
    },
    [router],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    disabled: busy !== null,
  });

  return (
    <div
      {...getRootProps()}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-center transition-colors",
        variant === "full" ? "p-10" : "p-4",
        isDragActive
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/25 hover:border-muted-foreground/50",
        busy && "cursor-wait opacity-70",
      )}
    >
      <input {...getInputProps()} />
      {busy ? (
        <>
          <Loader2
            className={cn(
              "animate-spin text-muted-foreground",
              variant === "full" ? "size-8" : "size-5",
            )}
          />
          <p className="text-sm text-muted-foreground">{busy}</p>
        </>
      ) : variant === "full" ? (
        <>
          <CloudUpload className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">
            Drop documents here, or click to browse
          </p>
          <p className="text-xs text-muted-foreground">
            Port entries, bills of lading, purchase orders, invoices, quote
            sheets, refund reports — single files or bulk.
          </p>
        </>
      ) : (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <CloudUpload className="size-4" /> Drop a file, or click to browse
        </p>
      )}
    </div>
  );
}
