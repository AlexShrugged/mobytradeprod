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

// full: the Data page hero dropzone — it frees up for the next batch as
// soon as the current one's bytes are registered; processing progress lives
// on the table rows below. compact: a one-line affordance for embedding in
// dialogs (e.g. quote upload in New SKU) — it stays busy until the batch
// settles, since the dialog has no table to point at. onComplete fires once
// a batch has fully settled (uploaded + processed), with whether every file
// made it — dialogs use it to close themselves on success.
export function UploadDropzone({
  variant = "full",
  onComplete,
}: {
  variant?: "full" | "compact";
  onComplete?: (allSucceeded: boolean) => void;
}) {
  const router = useRouter();
  const status = useUploadStatus();
  const [busy, setBusy] = React.useState<string | null>(null);
  // Which batch currently owns `busy`: the full variant re-enables mid-flow,
  // so an earlier batch settling in the background must not clear a later
  // batch's upload indicator.
  const busyOwner = React.useRef<string | null>(null);

  // Refreshing or closing the tab mid-upload aborts the browser-direct
  // transfers and loses the files entirely — warn first. Scoped to the
  // upload phase (a counter, since batches can overlap): once rows are
  // registered, processing is server-side and the sweep finishes anything
  // the tab doesn't.
  const [uploadingCount, setUploadingCount] = React.useState(0);
  React.useEffect(() => {
    if (uploadingCount === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploadingCount]);

  const onDrop = React.useCallback(
    async (accepted: File[]) => {
      if (accepted.length === 0) return;

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

      const setBatchBusy = (msg: string) => {
        busyOwner.current = batch;
        setBusy(msg);
      };
      const clearBatchBusy = () => {
        if (busyOwner.current !== batch) return;
        busyOwner.current = null;
        setBusy(null);
      };

      // Phase 1: upload + register. The dropzone blocks for this stretch —
      // dropping more files mid-transfer would contend for the same pool.
      setBatchBusy(
        `Uploading ${accepted.length} file${accepted.length > 1 ? "s" : ""}…`,
      );
      setUploadingCount((n) => n + 1);
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
                    // The store is private — broker docs are never
                    // world-readable; reads go through the download route.
                    access: "private",
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
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
        onComplete?.(false);
        clearBatchBusy();
        status?.setPending((prev) =>
          prev.filter((it) => !it.key.startsWith(`${batch}-`)),
        );
        router.refresh();
        return;
      } finally {
        setUploadingCount((n) => n - 1);
      }

      // All bytes are safely in the store; a refresh from here on can no
      // longer lose anything. The full dropzone hands back "Drop documents
      // here" now — processing status lives on the table rows — while the
      // compact one stays busy so its host dialog reads as working.
      if (variant === "full") clearBatchBusy();
      else setBatchBusy(`Processing 0 of ${registered.length}…`);

      // Phase 2: process in a small concurrent pool: real extraction is
      // minutes per document and independent across documents, so the batch
      // takes roughly as long as its slowest doc. The cap keeps provider
      // rate limits and concurrent linker writes at bay. Status from here on
      // lives on the real table rows (pending → processing → processed).
      try {
        const processQueue = [...registered];
        let done = 0;
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
              if (variant !== "full")
                setBatchBusy(`Processing ${done} of ${registered.length}…`);
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
        onComplete?.(failed === 0);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
        onComplete?.(false);
      } finally {
        clearBatchBusy();
        status?.setPending((prev) =>
          prev.filter((it) => !it.key.startsWith(`${batch}-`)),
        );
        router.refresh();
      }
    },
    [router, status, onComplete, variant],
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
            sheets, refund reports. Single files or bulk.
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
