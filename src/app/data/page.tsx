import { DocumentsTable } from "@/components/data/documents-table";
import { SourceCards } from "@/components/data/source-cards";
import { UploadDropzone } from "@/components/data/upload-dropzone";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDocuments } from "@/lib/db/queries/documents";
import { getIntegrationSources } from "@/lib/db/queries/integrations";

export const dynamic = "force-dynamic";

export default async function DataPage() {
  const [documents, sources] = await Promise.all([
    getDocuments(),
    getIntegrationSources(),
  ]);
  // The manual-upload source IS the dropzone; the cards show the automated
  // intake seams (SFTP / email inbox / ERP).
  const channelSources = sources.filter((s) => s.kind !== "manual_upload");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Data</h1>
        <p className="text-sm text-muted-foreground">
          Document uploads, intake channels, and integrations — managed in one
          place.
        </p>
      </div>

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
        <DocumentsTable documents={documents} />
      </div>
    </div>
  );
}
