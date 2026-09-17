import type { IntegrationKind } from "@/lib/db/schema";

// The Data page's Source column, decided on read from two facts a document
// carries: the intake channel (integration_sources.kind via source_id) and
// the uploading user (documents.uploaded_by). An automated channel is its
// own answer — the file arrived by SFTP / email / ERP, no person uploaded
// it. A native upload names the person; a native upload from before the
// name was recorded falls back to the channel label, and a row with no
// channel and no person shows nothing. Pure — shared by the client table.

export const sourceKindLabels: Record<IntegrationKind, string> = {
  manual_upload: "Manual",
  sftp: "SFTP",
  email_inbox: "Email",
  erp: "ERP",
};

export function documentSourceLabel(doc: {
  sourceKind: IntegrationKind | null;
  uploadedBy: string | null;
}): string | null {
  if (doc.sourceKind !== null && doc.sourceKind !== "manual_upload") {
    return sourceKindLabels[doc.sourceKind];
  }
  const person = doc.uploadedBy?.trim();
  if (person) return person;
  return doc.sourceKind === null ? null : sourceKindLabels[doc.sourceKind];
}
