"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Download,
  FileJson,
  MoreHorizontal,
  Play,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
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

export function DocumentsTable({ documents }: { documents: DocumentRow[] }) {
  const router = useRouter();
  const [viewing, setViewing] = React.useState<DocumentRow | null>(null);
  const [processingId, setProcessingId] = React.useState<string | null>(null);

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
            {documents.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="h-24 text-center text-muted-foreground"
                >
                  No documents yet — drop files above to get started.
                </TableCell>
              </TableRow>
            ) : (
              documents.map((doc) => {
                const isBusy = processingId === doc.id;
                const status = isBusy ? "processing" : doc.status;
                return (
                  <TableRow key={doc.id}>
                    <TableCell className="max-w-64">
                      <div className="truncate font-medium">{doc.fileName}</div>
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
                          {doc.status === "pending" && (
                            <DropdownMenuItem onClick={() => processDocument(doc)}>
                              <Play /> Process now
                            </DropdownMenuItem>
                          )}
                          {(doc.status === "failed" ||
                            doc.status === "processed") && (
                            <DropdownMenuItem onClick={() => processDocument(doc)}>
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
