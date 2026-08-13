import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isSuperAdmin } from "@/lib/admin";
import { getTariffStatus } from "@/lib/db/queries/tariffs";
import { getVendors } from "@/lib/db/queries/vendors";
import { formatDateTime } from "@/lib/format";
import { getCurrentOrg } from "@/lib/org";

import { OrgCard } from "./org-card";
import { VendorsCard } from "./vendors-card";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [org, tariff, vendors, admin] = await Promise.all([
    getCurrentOrg(),
    getTariffStatus(),
    getVendors(),
    isSuperAdmin(),
  ]);
  // Env presence decides the processor at request time — force-dynamic
  // keeps this honest after an env change.
  const reductoConfigured = Boolean(process.env.REDUCTO_API_KEY);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        info="Organization, vendors, tariff reference data, and document processing."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <OrgCard
          name={org.name}
          importerOfRecord={org.importerOfRecord}
          inboxAddress={org.inboxAddress}
        />

        <VendorsCard vendors={vendors} />

        {/* Read-only facts about the global reference. Operations on it
            (sync, approvals) live behind the super-admin seam at /admin. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tariff schedule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <span className="font-medium tabular-nums">
                {tariff.measureCount}
              </span>{" "}
              trade measure{tariff.measureCount === 1 ? "" : "s"} across{" "}
              <span className="font-medium tabular-nums">
                {tariff.authorityCount}
              </span>{" "}
              authorit{tariff.authorityCount === 1 ? "y" : "ies"}
            </div>
            <div className="text-muted-foreground">
              <span className="font-medium tabular-nums text-foreground">
                {tariff.baseCodeCount.toLocaleString()}
              </span>{" "}
              base HTS codes ·{" "}
              <span className="font-medium tabular-nums text-foreground">
                {tariff.ch99RowCount}
              </span>{" "}
              Chapter 99 measure lines
            </div>
            <div className="text-muted-foreground">
              Last sync:{" "}
              {tariff.lastSyncAt ? formatDateTime(tariff.lastSyncAt) : "never"}
            </div>
            <div className="flex items-center gap-2 pt-1">
              {tariff.openRevisionCount > 0 ? (
                <Badge className="border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                  {tariff.openRevisionCount} pending change
                  {tariff.openRevisionCount === 1 ? "" : "s"}
                </Badge>
              ) : (
                <Badge className="border-transparent bg-muted text-muted-foreground">
                  Reference up to date
                </Badge>
              )}
              {admin ? (
                <Link
                  href="/admin"
                  className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                >
                  Platform admin <ArrowRight className="size-3.5" />
                </Link>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Document processing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              {reductoConfigured ? (
                <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                  Reducto configured
                </Badge>
              ) : (
                <Badge className="border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                  Simulation mode
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground">
              {reductoConfigured
                ? "Uploaded documents are parsed by Reducto; full extraction payloads are retained for provenance."
                : "REDUCTO_API_KEY is not set; uploads run through the deterministic stub processor. Set the key to enable live extraction."}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
