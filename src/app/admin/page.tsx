import Link from "next/link";
import { notFound } from "next/navigation";
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
import { formatDateTime } from "@/lib/format";

import { SyncButton } from "./sync-button";

export const dynamic = "force-dynamic";

// Platform-operator home: global customs reference operations (sync,
// review queue). Org-facing Settings keeps the read-only facts; everything
// here mutates data every tenant depends on. Each admin page guards itself —
// layouts render independently and are not a security boundary.
// Non-admins get a 404, not a lock screen — the surface stays hidden.
export default async function AdminPage() {
  if (!(await isSuperAdmin())) notFound();
  const tariff = await getTariffStatus();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform admin"
        info="Global customs reference data — syncs and approvals here take effect for every organization."
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Tariff schedule</CardTitle>
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
                href="/admin/tariffs"
                className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
              >
                Review queue <ArrowRight className="size-3.5" />
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
