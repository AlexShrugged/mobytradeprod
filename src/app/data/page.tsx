import { AutoRefresh } from "@/components/data/auto-refresh";
import { DocumentsTable } from "@/components/data/documents-table";
import { OrgRulesCard } from "@/components/data/org-rules-card";
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
import { getDocuments } from "@/lib/db/queries/documents";
import { getIntegrationSources } from "@/lib/db/queries/integrations";
import { getOrgRules } from "@/lib/db/queries/org-rules";

export const dynamic = "force-dynamic";

export default async function DataPage() {
  const [documents, sources, rules] = await Promise.all([
    getDocuments(),
    getIntegrationSources(),
    getOrgRules(),
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
        <DocumentsTable documents={documents} />
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold">Org rules</h2>
          <p className="text-sm text-muted-foreground">
            Standing instructions. Suppression rules hide matching variance
            alerts; every rule guides the AI.
          </p>
        </div>
        <OrgRulesCard rules={rules} />
      </div>
      </div>
    </UploadStatusProvider>
  );
}
