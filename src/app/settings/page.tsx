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
import { getOrgRules } from "@/lib/db/queries/org-rules";
import { getTariffStatus } from "@/lib/db/queries/tariffs";
import { getVendors } from "@/lib/db/queries/vendors";
import { formatDateTime } from "@/lib/format";
import { getCurrentOrg } from "@/lib/org";

import { CustomRulesCard } from "./custom-rules-card";
import { OrgCard } from "./org-card";
import { VendorsCard } from "./vendors-card";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [org, vendors, rules, admin] = await Promise.all([
    getCurrentOrg(),
    getVendors(),
    getOrgRules(),
    isSuperAdmin(),
  ]);
  const tariff = admin ? await getTariffStatus() : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        info="Organization, vendors, and custom rules."
      />

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-4">
          <OrgCard
            name={org.name}
            importerOfRecord={org.importerOfRecord}
            inboxAddress={org.inboxAddress}
          />

          {/* Read-only facts about the global reference, super-admin only.
              Operations on it (sync, approvals) live at /admin. */}
          {tariff ? (
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
                  {tariff.lastSyncAt
                    ? formatDateTime(tariff.lastSyncAt)
                    : "never"}
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
                  <Link
                    href="/admin"
                    className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                  >
                    Platform admin <ArrowRight className="size-3.5" />
                  </Link>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <CustomRulesCard rules={rules} />

          <VendorsCard vendors={vendors} />
        </div>
      </div>
    </div>
  );
}
