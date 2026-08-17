"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  CornerDownRight,
  Download,
  FileJson,
  Loader2,
  MoreHorizontal,
  Play,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { useUploadStatus } from "@/components/data/upload-status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DocumentListItem, IntegrationKind } from "@/lib/db/schema";
import { docTypeLabel, formatBytes, formatDateTime } from "@/lib/format";
import { packetRoleLabel, pageRangeLabel } from "@/lib/processing/packet";

// Mirrors DocumentWithSource from queries/documents.ts (type-only — the
// query module itself is server-only).
export type DocumentRow = DocumentListItem & {
  sourceName: string | null;
  sourceKind: IntegrationKind | null;
};

const sourceKindLabels: Record<IntegrationKind, string> = {
  manual_upload: "Manual",
  sftp: "SFTP",
  email_inbox: "Email",
  erp: "ERP",
};

// Packet children render directly under their parent, indented; a child
// whose parent fell out of the list (filtered away) renders as a root.
function orderWithChildren(documents: DocumentRow[]): DocumentRow[] {
  const ids = new Set(documents.map((d) => d.id));
  const childrenByParent = new Map<string, DocumentRow[]>();
  for (const doc of documents) {
    if (doc.parentDocumentId && ids.has(doc.parentDocumentId)) {
      const list = childrenByParent.get(doc.parentDocumentId) ?? [];
      list.push(doc);
      childrenByParent.set(doc.parentDocumentId, list);
    }
  }
  const ordered: DocumentRow[] = [];
  for (const doc of documents) {
    if (doc.parentDocumentId && ids.has(doc.parentDocumentId)) continue;
    ordered.push(doc);
    const children = childrenByParent.get(doc.id);
    if (children) {
      ordered.push(
        ...[...children].sort(
          (a, b) => (a.pageRange?.[0] ?? 0) - (b.pageRange?.[0] ?? 0),
        ),
      );
    }
  }
  return ordered;
}

export function DocumentsTable({ documents }: { documents: DocumentRow[] }) {
  const router = useRouter();
  const [viewing, setViewing] = React.useState<DocumentRow | null>(null);
  const [processingId, setProcessingId] = React.useState<string | null>(null);

  // In-flight uploads render as pending rows at the top — each one hides
  // itself the moment its real (registered) row arrives from the server.
  const uploadStatus = useUploadStatus();
  const pendingUploads = (uploadStatus?.pending ?? []).filter(
    (p) => !p.storageKey || !documents.some((d) => d.storageKey === p.storageKey),
  );

  const processDocument = async (doc: DocumentRow) => {
    setProcessingId(doc.id);
    router.refresh();
    try {
      const res = await fetch(`/api/documents/${doc.id}/process`, {
        method: "POST",
      });
      const body = await res.json();
      if (res.ok) {
        toast.success(`${doc.fileName} processed.`);
      } else {
        toast.error(
          body?.document?.errorMessage ??
            body?.error ??
            `Processing ${doc.fileName} failed.`,
        );
      }
    } catch {
      toast.error(`Processing ${doc.fileName} failed.`);
    } finally {
      setProcessingId(null);
      router.refresh();
    }
  };

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead>Processed</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {pendingUploads.map((p) => (
              <TableRow key={p.key}>
                <TableCell className="max-w-64">
                  <span className="block truncate font-medium">{p.name}</span>
                </TableCell>
                <TableCell className="text-muted-foreground">—</TableCell>
                <TableCell className="text-muted-foreground">Manual</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    {p.stage === "failed" ? (
                      <XCircle className="size-3.5 text-red-500" />
                    ) : (
                      <Loader2 className="size-3.5 animate-spin" />
                    )}
                    {p.stage === "failed"
                      ? "Upload failed"
                      : p.stage === "queued"
                        ? "Queued"
                        : p.pct > 0
                          ? `Uploading ${p.pct}%`
                          : "Uploading…"}
                  </span>
                </TableCell>
                <TableCell>{formatBytes(p.size)}</TableCell>
                <TableCell className="text-muted-foreground">—</TableCell>
                <TableCell className="text-muted-foreground">—</TableCell>
                <TableCell />
              </TableRow>
            ))}
            {documents.length === 0 && pendingUploads.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="h-24 text-center text-muted-foreground"
                >
                  No documents yet. Drop files above.
                </TableCell>
              </TableRow>
            ) : (
              orderWithChildren(documents).map((doc) => {
                const isBusy = processingId === doc.id;
                const status = isBusy ? "processing" : doc.status;
                const isChild = doc.parentDocumentId !== null;
                return (
                  <TableRow key={doc.id}>
                    <TableCell className="max-w-64">
                      <div
                        className={
                          isChild
                            ? "flex items-center gap-1.5 pl-5"
                            : undefined
                        }
                      >
                        {isChild ? (
                          <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : null}
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {doc.fileName}
                          </div>
                          {isChild && doc.packetRole ? (
                            <div className="text-xs text-muted-foreground">
                              {packetRoleLabel(doc.packetRole)}
                              {doc.pageRange?.length
                                ? ` · ${pageRangeLabel(doc.pageRange)}`
                                : ""}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      {doc.status === "failed" && doc.errorMessage && (
                        <div className="truncate text-xs text-destructive">
                          {doc.errorMessage}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {docTypeLabel(doc.docType)}
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground"
                      title={doc.sourceName ?? undefined}
                    >
                      {doc.sourceKind ? sourceKindLabels[doc.sourceKind] : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatBytes(doc.fileSize)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(doc.uploadedAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(doc.processedAt)}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            disabled={isBusy}
                            aria-label={`Actions for ${doc.fileName}`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {/* Catalog imports have no pipeline processor —
                              they apply on the Parts page at upload time. */}
                          {doc.status === "pending" &&
                            doc.docType !== "part_catalog" && (
                              <DropdownMenuItem
                                onClick={() => processDocument(doc)}
                              >
                                <Play /> Process now
                              </DropdownMenuItem>
                            )}
                          {(doc.status === "failed" ||
                            doc.status === "processed") &&
                            doc.docType !== "part_catalog" && (
                              <DropdownMenuItem
                                onClick={() => processDocument(doc)}
                              >
                                <RefreshCw /> Reprocess
                              </DropdownMenuItem>
                            )}
                          {doc.extractedData != null && (
                            <DropdownMenuItem onClick={() => setViewing(doc)}>
                              <FileJson /> View extracted data
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem asChild>
                            <a href={`/api/documents/${doc.id}/file`} download>
                              <Download /> Download
                            </a>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="truncate">{viewing?.fileName}</DialogTitle>
            <DialogDescription>
              Fields extracted during document processing.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-96 overflow-auto rounded-md bg-muted p-4 text-xs">
            {JSON.stringify(viewing?.extractedData, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
