"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  Database,
  HardDriveDownload,
  Loader2,
  Mail,
  Play,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { IntegrationSource } from "@/lib/db/schema";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// Intake-channel cards for the Data page's right column: SFTP, email inbox,
// ERP (the manual-upload source is the dropzone itself). Config shapes per
// kind are seeded/mocked; the real connectors plug into
// lib/integrations/getConnector without changing this UI.

const statusDotClasses: Record<IntegrationSource["status"], string> = {
  active: "bg-emerald-500",
  paused: "bg-zinc-400",
  error: "bg-red-500",
  not_configured: "bg-zinc-300 dark:bg-zinc-600",
};

const statusLabels: Record<IntegrationSource["status"], string> = {
  active: "Active",
  paused: "Paused",
  error: "Error",
  not_configured: "Not configured",
};

function asConfig(source: IntegrationSource): Record<string, unknown> {
  return source.config && typeof source.config === "object"
    ? (source.config as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function StatusDot({ status }: { status: IntegrationSource["status"] }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn("size-2 rounded-full", statusDotClasses[status])}
        aria-hidden
      />
      {statusLabels[status]}
    </span>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate text-right font-medium">{value}</span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 shrink-0"
      aria-label="Copy address"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast.success("Address copied.");
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error("Could not copy to clipboard.");
        }
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

function SourceCard({ source }: { source: IntegrationSource }) {
  const router = useRouter();
  const [running, setRunning] = React.useState(false);
  const config = asConfig(source);

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await fetch(`/api/integrations/${source.id}/run`, {
        method: "POST",
      });
      const body = await res.json();
      if (res.ok) {
        toast.success(body?.message ?? `${source.name} ran.`);
      } else {
        toast.error(body?.error ?? body?.message ?? `${source.name} run failed.`);
      }
    } catch {
      toast.error(`${source.name} run failed.`);
    } finally {
      setRunning(false);
      router.refresh();
    }
  };

  const icon =
    source.kind === "sftp" ? (
      <HardDriveDownload className="size-4 text-muted-foreground" />
    ) : source.kind === "email_inbox" ? (
      <Mail className="size-4 text-muted-foreground" />
    ) : (
      <Database className="size-4 text-muted-foreground" />
    );

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="inline-flex items-center gap-2 text-sm">
            {icon}
            {source.name}
          </CardTitle>
          <StatusDot status={source.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5 px-4">
        {source.kind === "sftp" && (
          <>
            {str(config.host) && <Detail label="Host" value={str(config.host)} />}
            {str(config.folder) && (
              <Detail label="Folder" value={str(config.folder)} />
            )}
            {str(config.filePattern) && (
              <Detail label="Pattern" value={str(config.filePattern)} />
            )}
            <Detail
              label="Last file received"
              value={formatDateTime(source.lastReceivedAt)}
            />
          </>
        )}
        {source.kind === "email_inbox" && (
          <>
            {str(config.address) && (
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="shrink-0 text-muted-foreground">Address</span>
                <span className="inline-flex min-w-0 items-center gap-1">
                  <span className="truncate font-medium">
                    {str(config.address)}
                  </span>
                  <CopyButton text={str(config.address) as string} />
                </span>
              </div>
            )}
            <Detail
              label="Last received"
              value={formatDateTime(source.lastReceivedAt)}
            />
          </>
        )}
        {source.kind === "erp" && (
          <>
            {str(config.provider) && (
              <Detail label="Provider" value={str(config.provider)} />
            )}
            <Detail label="Last run" value={formatDateTime(source.lastRunAt)} />
          </>
        )}

        <div className="flex items-center gap-2 pt-2">
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span wrapper: disabled buttons swallow the hover events
                  the tooltip needs. */}
              <span tabIndex={0}>
                <Button variant="outline" size="sm" disabled>
                  Configure
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Coming soon — schema seam ready</TooltipContent>
          </Tooltip>
          {source.status === "active" && (
            <Button
              variant="outline"
              size="sm"
              onClick={runNow}
              disabled={running}
            >
              {running ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Play />
              )}
              Run now
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function SourceCards({ sources }: { sources: IntegrationSource[] }) {
  if (sources.length === 0) {
    return (
      <Card className="py-4">
        <CardContent className="px-4 text-sm text-muted-foreground">
          No intake sources configured. Seed the database to see the SFTP,
          email, and ERP seams.
        </CardContent>
      </Card>
    );
  }
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-3">
        {sources.map((source) => (
          <SourceCard key={source.id} source={source} />
        ))}
      </div>
    </TooltipProvider>
  );
}
