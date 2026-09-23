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
import {
  describeDuplicate,
  summarizeDuplicates,
  type DuplicateUpload,
} from "@/lib/documents/duplicates";
import { buildUploadKey } from "@/lib/documents/upload-key";
import { createChannel, drain } from "@/lib/documents/upload-pipeline";
import { cn } from "@/lib/utils";
import type { DocumentListItem } from "@/lib/db/schema";
import { apiFetch, orgPinHeaders } from "@/lib/org-pin-client";

// What both upload routes answer with: the rows they created, plus the
// files they refused as byte-identical to a document already on file.
type UploadResponse = {
  documents?: DocumentListItem[];
  duplicates?: DuplicateUpload[];
};

// Blob mode: files go browser → Vercel Blob directly (signed token from
// /api/documents/upload-token), then each file registers its row the moment
// its upload finishes. In-flight files surface as pending rows in the
// documents table (via UploadStatusProvider), not in this card. Legacy
// mode: one multipart POST against the local file store.
const BLOB_UPLOADS = process.env.NEXT_PUBLIC_STORAGE_DRIVER === "blob";

// Files in flight to the store at once. Past this the extra slots stop
// buying speed: the uploader's upstream link is the ceiling for large
// files, the Blob client already sends 6 parts per large file in parallel
// and buffers up to 96 MB for each one, and upload tokens expire after an
// hour. Eight overlaps the fixed per-file overhead (token, multipart
// handshake, register) that dominates batches of small files.
const UPLOAD_POOL = 8;

// Documents in extraction at once: one slot runs a whole packet (parent,
// then each child) through Reducto, which answers too many concurrent
// calls with a 429 that fails the document. The document sweep uses the
// same figure for the same reason, plus concurrent linker writes.
const PROCESS_POOL = 3;

function registerUpload(u: {
  storageKey: string;
  fileName: string;
  mimeType: string;
}): Promise<Response> {
  return apiFetch("/api/documents/register", {
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
      // Files the server recognized as already on file: never registered,
      // never processed, reported once at the end.
      const duplicates: DuplicateUpload[] = [];
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

      // Registered rows flow straight into extraction: upload workers push
      // each document the moment its row exists and processing workers
      // take them as they come, so extraction runs during the upload
      // instead of after it. Real extraction is minutes per document and
      // independent across documents, so a batch takes about the longer
      // of its upload and its slowest documents, not the sum. Status from
      // the moment a row exists lives on the real table rows (pending →
      // processing → processed).
      const pipeline = createChannel<DocumentListItem>();
      let uploadsSettled = false;
      let done = 0;
      const processing = drain(
        pipeline,
        Math.min(PROCESS_POOL, accepted.length),
        async (doc) => {
          const ok = await apiFetch(`/api/documents/${doc.id}/process`, {
            method: "POST",
          })
            .then((res) => res.ok)
            .catch(() => false);
          if (!ok) failed += 1;
          done += 1;
          // The compact dropzone narrates processing only once the upload
          // is over; until then its message is the upload's.
          if (variant !== "full" && uploadsSettled)
            setBatchBusy(`Processing ${done} of ${registered.length}…`);
          router.refresh();
        },
      );
      const admit = (doc: DocumentListItem) => {
        registered.push(doc);
        pipeline.push(doc);
      };

      // Upload + register. The dropzone blocks for this stretch — dropping
      // more files mid-transfer would contend for the same pool.
      setBatchBusy(
        `Uploading ${accepted.length} file${accepted.length > 1 ? "s" : ""}…`,
      );
      setUploadingCount((n) => n + 1);
      try {
        if (BLOB_UPLOADS) {
          // Each file's row is created (and shows in the table as pending)
          // as soon as its own bytes land, and enters extraction right
          // then. One bad file marks itself failed without sinking the
          // batch.
          const queue = accepted.map((file, index) => ({ file, index }));
          await Promise.all(
            Array.from(
              { length: Math.min(UPLOAD_POOL, queue.length) },
              async () => {
                for (let job = queue.shift(); job; job = queue.shift()) {
                  const { file, index } = job;
                  try {
                    const result = await upload(
                      buildUploadKey(file.name),
                      file,
                      {
                        // The store is private — broker docs are never
                        // world-readable; reads go through the download
                        // route.
                        access: "private",
                        handleUploadUrl: "/api/documents/upload-token",
                        headers: orgPinHeaders(),
                        multipart: true,
                        contentType: file.type || "application/octet-stream",
                        onUploadProgress: ({ percentage }) =>
                          patch(index, { pct: Math.round(percentage) }),
                      },
                    );
                    const res = await registerUpload({
                      storageKey: result.pathname,
                      fileName: file.name,
                      mimeType: file.type || "application/octet-stream",
                    });
                    const body = (await res
                      .json()
                      .catch(() => null)) as UploadResponse | null;
                    const duplicate = body?.duplicates?.[0];
                    if (res.status === 409 && duplicate) {
                      duplicates.push({ ...duplicate, index });
                      patch(index, {
                        stage: "duplicate",
                        pct: 100,
                        note: describeDuplicate(duplicate.duplicateOf),
                      });
                      continue;
                    }
                    const doc = body?.documents?.[0];
                    if (!res.ok || !doc) {
                      throw new Error("Registration failed.");
                    }
                    admit(doc);
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
              },
            ),
          );
        } else {
          const formData = new FormData();
          for (const file of accepted) formData.append("files", file);
          const res = await apiFetch("/api/documents/upload", {
            method: "POST",
            body: formData,
          });
          const body = (await res
            .json()
            .catch(() => null)) as UploadResponse | null;
          const dups = body?.duplicates ?? [];
          // 409 means every file was a duplicate — a full answer, not a
          // failure.
          if (!res.ok && !(res.status === 409 && dups.length > 0)) {
            throw new Error("Upload failed.");
          }
          for (const d of dups) {
            duplicates.push(d);
            patch(d.index, {
              stage: "duplicate",
              pct: 100,
              note: describeDuplicate(d.duplicateOf),
            });
          }
          const documents = body?.documents ?? [];
          // Response order matches file order, minus the duplicates.
          const skipped = new Set(dups.map((d) => d.index));
          const order = accepted
            .map((_, index) => index)
            .filter((index) => !skipped.has(index));
          documents.forEach((doc, k) => {
            admit(doc);
            patch(order[k], {
              stage: "queued",
              pct: 100,
              storageKey: doc.storageKey,
            });
          });
          router.refresh();
        }
      } catch (err) {
        // Only the legacy path lands here, and it throws before
        // registering anything (the blob path contains failures per
        // file). Close the pipeline anyway so the processing workers
        // return before the batch is torn down.
        pipeline.close();
        await processing;
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
      pipeline.close();
      uploadsSettled = true;
      if (variant === "full") clearBatchBusy();
      else setBatchBusy(`Processing ${done} of ${registered.length}…`);

      try {
        await processing;

        const attempted = accepted.length - duplicates.length;
        const succeeded = attempted - failed;
        if (failed > 0) {
          toast.warning(
            `${succeeded} of ${attempted} documents processed; ${failed} failed. You can reprocess failures from the table.`,
          );
        } else if (succeeded > 0) {
          toast.success(
            `${succeeded} document${succeeded > 1 ? "s" : ""} processed.`,
          );
        }
        if (duplicates.length > 0) toast.info(summarizeDuplicates(duplicates));
        onComplete?.(failed === 0 && succeeded > 0);
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
