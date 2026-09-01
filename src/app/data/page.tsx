import { AutoRefresh } from "@/components/data/auto-refresh";
import { DocumentsView } from "@/components/data/documents-view";
import { PageHeader } from "@/components/page-header";
import { SourceCards } from "@/components/data/source-cards";
import { UploadDropzone } from "@/components/data/upload-dropzone";
import { UploadStatusProvider } from "@/components/data/upload-status";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDocumentsPage } from "@/lib/db/queries/documents";
import { getIntegrationSources } from "@/lib/db/queries/integrations";
import { parsePageParams } from "@/lib/pagination";

export const dynamic = "force-dynamic";

// Search (?q=) and pagination (?page=, ?per=) are server-side — only one
// page of documents is ever assembled.
export default async function DataPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; per?: string }>;
}) {
  const params = await searchParams;
  const { page: requestedPage, per } = parsePageParams(params);
  const q = (params.q ?? "").trim() || null;

  const [{ rows: documents, totalCount, filteredCount, page }, sources] =
    await Promise.all([
      getDocumentsPage({ page: requestedPage, per, q }),
      getIntegrationSources(),
    ]);
  // The manual-upload source IS the dropzone; the cards show the automated
  // intake seams we support (SFTP / email inbox). Allowlisted, not
  // denylisted, so retired kinds still present in existing rows never render.
  const channelSources = sources.filter(
    (s) => s.kind === "sftp" || s.kind === "email_inbox",
  );
  const anyInFlight = documents.some(
    (d) => d.status === "pending" || d.status === "processing",
  );

  return (
    // Provider ties the dropzone to the documents table: in-flight uploads
    // render as pending rows in the table itself.
    <UploadStatusProvider>
      <AutoRefresh active={anyInFlight} />
      <div className="space-y-6">
      <PageHeader
        title="Data"
        info="Document uploads and intake channels in one place."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Upload documents</CardTitle>
            <CardDescription>
              Files are classified by type and processed into entries,
              shipments, purchase orders, and quotes automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UploadDropzone />
          </CardContent>
        </Card>

        <SourceCards sources={channelSources} />
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold">Documents</h2>
          <p className="text-sm text-muted-foreground">
            Everything brought into MobyTrade, with processing status.
          </p>
        </div>
        <DocumentsView
          documents={documents}
          totalCount={totalCount}
          filteredCount={filteredCount}
          page={page}
          per={per}
          initialQuery={q ?? ""}
        />
      </div>
      </div>
    </UploadStatusProvider>
  );
}
