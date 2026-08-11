"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { useDropzone } from "react-dropzone";
import { CheckCircle2, CloudUpload, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";

import { buildUploadKey } from "@/lib/documents/upload-key";
import { cn } from "@/lib/utils";
import type { DocumentListItem } from "@/lib/db/schema";

// Blob mode: files go browser → Vercel Blob directly (signed token from
// /api/documents/upload-token), then each file registers its row the moment
// its upload finishes — so documents appear in the table (as pending, then
// processing) while the rest of the batch is still uploading. Legacy mode:
// one multipart POST against the local file store.
const BLOB_UPLOADS = process.env.NEXT_PUBLIC_STORAGE_DRIVER === "blob";

type Stage = "uploading" | "queued" | "processing" | "processed" | "failed";

type ItemState = { name: string; stage: Stage; pct: number };

const STAGE_LABEL: Record<Stage, string> = {
  uploading: "uploading",
  queued: "waiting to process",
  processing: "processing…",
  processed: "done",
  failed: "failed",
};

function registerUploads(uploads: {
  storageKey: string;
  fileName: string;
  mimeType: string;
}[]): Promise<Response> {
  return fetch("/api/documents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploads }),
  });
}

// full: the Data page hero dropzone. compact: a one-line affordance for
// embedding in dialogs (e.g. quote upload in New SKU).
export function UploadDropzone({
  variant = "full",
}: {
  variant?: "full" | "compact";
}) {
  const router = useRouter();
  const [items, setItems] = React.useState<ItemState[] | null>(null);

  const setItem = React.useCallback(
    (index: number, patch: Partial<ItemState>) => {
      setItems((prev) =>
        prev
          ? prev.map((it, i) => (i === index ? { ...it, ...patch } : it))
          : prev,
      );
    },
    [],
  );

  const onDrop = React.useCallback(
    async (accepted: File[]) => {
      if (accepted.length === 0) return;
      setItems(
        accepted.map((f) => ({ name: f.name, stage: "uploading", pct: 0 })),
      );

      // Docs that made it into the database, paired with their list index.
      const registered: { doc: DocumentListItem; index: number }[] = [];

      try {
        if (BLOB_UPLOADS) {
          // Upload pool of 3; each file registers (and appears in the
          // table) as soon as its own bytes land. One bad file marks
          // itself failed without sinking the batch.
          const queue = accepted.map((file, index) => ({ file, index }));
          await Promise.all(
            Array.from(
              { length: Math.min(3, queue.length) },
              async () => {
                for (let job = queue.shift(); job; job = queue.shift()) {
                  const { file, index } = job;
                  try {
                    const result = await upload(
                      buildUploadKey(file.name),
                      file,
                      {
                        access: "public",
                        handleUploadUrl: "/api/documents/upload-token",
                        multipart: true,
                        contentType: file.type || "application/octet-stream",
                        onUploadProgress: ({ percentage }) =>
                          setItem(index, { pct: Math.round(percentage) }),
                      },
                    );
                    const res = await registerUploads([
                      {
                        storageKey: result.pathname,
                        fileName: file.name,
                        mimeType: file.type || "application/octet-stream",
                      },
                    ]);
                    if (!res.ok) throw new Error("Registration failed.");
                    const { documents } = (await res.json()) as {
                      documents: DocumentListItem[];
                    };
                    registered.push({ doc: documents[0], index });
                    setItem(index, { stage: "queued", pct: 100 });
                    router.refresh();
                  } catch {
                    setItem(index, { stage: "failed" });
                  }
                }
              },
            ),
          );
        } else {
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
          // Response order matches file order.
          documents.forEach((doc, index) => {
            registered.push({ doc, index });
            setItem(index, { stage: "queued", pct: 100 });
          });
          router.refresh();
        }

        // Process in a small concurrent pool: real extraction is minutes
        // per document and independent across documents, so the batch takes
        // roughly as long as its slowest doc. The cap keeps provider rate
        // limits and concurrent linker writes at bay.
        const processQueue = [...registered];
        let failed = accepted.length - registered.length;
        await Promise.all(
          Array.from(
            { length: Math.min(3, processQueue.length) },
            async () => {
              for (
                let job = processQueue.shift();
                job;
                job = processQueue.shift()
              ) {
                setItem(job.index, { stage: "processing" });
                const ok = await fetch(`/api/documents/${job.doc.id}/process`, {
                  method: "POST",
                })
                  .then((res) => res.ok)
                  .catch(() => false);
                if (!ok) failed += 1;
                setItem(job.index, { stage: ok ? "processed" : "failed" });
                router.refresh();
              }
            },
          ),
        );

        if (failed > 0) {
          toast.warning(
            `${accepted.length - failed} of ${accepted.length} documents processed; ${failed} failed. You can reprocess failures from the table.`,
          );
        } else {
          toast.success(
            `${accepted.length} document${accepted.length > 1 ? "s" : ""} processed.`,
          );
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setItems(null);
        router.refresh();
      }
    },
    [router, setItem],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    disabled: items !== null,
  });

  const busySummary = items
    ? items.some((it) => it.stage === "uploading")
      ? `Uploading ${items.length} file${items.length > 1 ? "s" : ""}…`
      : `Processing ${items.filter((it) => it.stage === "processed" || it.stage === "failed").length} of ${items.length}…`
    : null;

  return (
    <div
      {...getRootProps()}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-center transition-colors",
        variant === "full" ? "p-10" : "p-4",
        isDragActive
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/25 hover:border-muted-foreground/50",
        items && "cursor-wait",
      )}
    >
      <input {...getInputProps()} />
      {items ? (
        <>
          <Loader2
            className={cn(
              "animate-spin text-muted-foreground",
              variant === "full" ? "size-6" : "size-5",
            )}
          />
          <p className="text-sm text-muted-foreground">{busySummary}</p>
          {variant === "full" && (
            <ul className="mt-1 w-full max-w-md space-y-1 text-left">
              {items.map((it, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {it.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    {it.stage === "processed" ? (
                      <CheckCircle2 className="size-3.5 text-emerald-600" />
                    ) : it.stage === "failed" ? (
                      <XCircle className="size-3.5 text-red-500" />
                    ) : (
                      <Loader2 className="size-3.5 animate-spin" />
                    )}
                    {it.stage === "uploading"
                      ? `uploading ${it.pct}%`
                      : STAGE_LABEL[it.stage]}
                  </span>
                </li>
              ))}
            </ul>
          )}
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
