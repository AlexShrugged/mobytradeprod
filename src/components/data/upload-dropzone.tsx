"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { useDropzone } from "react-dropzone";
import { CloudUpload, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  useUploadStatus,
  type PendingUpload,
} from "@/components/data/upload-status";
import { buildUploadKey } from "@/lib/documents/upload-key";
import { cn } from "@/lib/utils";
import type { DocumentListItem } from "@/lib/db/schema";

// Blob mode: files go browser → Vercel Blob directly (signed token from
// /api/documents/upload-token), then each file registers its row the moment
// its upload finishes. In-flight files surface as pending rows in the
// documents table (via UploadStatusProvider), not in this card. Legacy
// mode: one multipart POST against the local file store.
const BLOB_UPLOADS = process.env.NEXT_PUBLIC_STORAGE_DRIVER === "blob";

function registerUpload(u: {
  storageKey: string;
  fileName: string;
  mimeType: string;
}): Promise<Response> {
  return fetch("/api/documents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploads: [u] }),
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
  const status = useUploadStatus();
  const [busy, setBusy] = React.useState<string | null>(null);

  const onDrop = React.useCallback(
    async (accepted: File[]) => {
      if (accepted.length === 0) return;
      setBusy(
        `Uploading ${accepted.length} file${accepted.length > 1 ? "s" : ""}…`,
      );

      const batch = `${Date.now()}`;
      const keyOf = (index: number) => `${batch}-${index}`;
      status?.setPending((prev) => [
        ...prev,
        ...accepted.map((f, index) => ({
          key: keyOf(index),
          name: f.name,
          size: f.size,
          pct: 0,
          stage: "uploading" as const,
        })),
      ]);
      const patch = (index: number, p: Partial<PendingUpload>) =>
        status?.setPending((prev) =>
          prev.map((it) => (it.key === keyOf(index) ? { ...it, ...p } : it)),
        );

      const registered: DocumentListItem[] = [];
      let failed = 0;

      try {
        if (BLOB_UPLOADS) {
          // Upload pool of 3; each file's row is created (and shows in the
          // table as pending) as soon as its own bytes land. One bad file
          // marks itself failed without sinking the batch.
          const queue = accepted.map((file, index) => ({ file, index }));
          await Promise.all(
            Array.from({ length: Math.min(3, queue.length) }, async () => {
              for (let job = queue.shift(); job; job = queue.shift()) {
                const { file, index } = job;
                try {
                  const result = await upload(buildUploadKey(file.name), file, {
                    access: "public",
                    handleUploadUrl: "/api/documents/upload-token",
                    multipart: true,
                    contentType: file.type || "application/octet-stream",
                    onUploadProgress: ({ percentage }) =>
                      patch(index, { pct: Math.round(percentage) }),
                  });
                  const res = await registerUpload({
                    storageKey: result.pathname,
                    fileName: file.name,
                    mimeType: file.type || "application/octet-stream",
                  });
                  if (!res.ok) throw new Error("Registration failed.");
                  const { documents } = (await res.json()) as {
                    documents: DocumentListItem[];
                  };
                  registered.push(documents[0]);
                  patch(index, {
                    stage: "queued",
                    pct: 100,
                    storageKey: result.pathname,
                  });
                  router.refresh();
                } catch {
                  failed += 1;
                  patch(index, { stage: "failed" });
                }
              }
            }),
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
          registered.push(...documents);
          // Response order matches file order.
          documents.forEach((doc, index) =>
            patch(index, {
              stage: "queued",
              pct: 100,
              storageKey: doc.storageKey,
            }),
          );
          router.refresh();
        }

        // Process in a small concurrent pool: real extraction is minutes
        // per document and independent across documents, so the batch takes
        // roughly as long as its slowest doc. The cap keeps provider rate
        // limits and concurrent linker writes at bay. Status from here on
        // lives on the real table rows (pending → processing → processed).
        const processQueue = [...registered];
        let done = 0;
        setBusy(`Processing 0 of ${registered.length}…`);
        await Promise.all(
          Array.from({ length: Math.min(3, processQueue.length) }, async () => {
            for (
              let doc = processQueue.shift();
              doc;
              doc = processQueue.shift()
            ) {
              const ok = await fetch(`/api/documents/${doc.id}/process`, {
                method: "POST",
              })
                .then((res) => res.ok)
                .catch(() => false);
              if (!ok) failed += 1;
              done += 1;
              setBusy(`Processing ${done} of ${registered.length}…`);
              router.refresh();
            }
          }),
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
        setBusy(null);
        status?.setPending((prev) =>
          prev.filter((it) => !it.key.startsWith(`${batch}-`)),
        );
        router.refresh();
      }
    },
    [router, status],
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
          {variant === "full" && (
            <p className="text-xs text-muted-foreground">
              Follow each file&apos;s progress in the documents table below.
            </p>
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
