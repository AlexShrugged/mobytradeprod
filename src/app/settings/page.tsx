import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTariffStatus } from "@/lib/db/queries/tariffs";
import { formatDateTime } from "@/lib/format";
import { getCurrentOrg } from "@/lib/org";

import { OrgCard } from "./org-card";
import { SyncButton } from "./sync-button";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [org, tariff] = await Promise.all([getCurrentOrg(), getTariffStatus()]);
  // Env presence decides the processor at request time — force-dynamic
  // keeps this honest after an env change.
  const reductoConfigured = Boolean(process.env.REDUCTO_API_KEY);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Organization, tariff reference data, and document processing.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <OrgCard
          name={org.name}
          importerOfRecord={org.importerOfRecord}
          inboxAddress={org.inboxAddress}
        />

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Tariff reference</CardTitle>
            <SyncButton />
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
                  {tariff.openRevisionCount} open revision
                  {tariff.openRevisionCount === 1 ? "" : "s"}
                </Badge>
              ) : (
                <Badge className="border-transparent bg-muted text-muted-foreground">
                  Review queue empty
                </Badge>
              )}
              <Link
                href="/settings/tariffs"
                className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
              >
                Review queue <ArrowRight className="size-3.5" />
              </Link>
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
                : "REDUCTO_API_KEY is not set — uploads run through the deterministic stub processor. Add the key to the environment to switch to live extraction; no code change needed."}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
