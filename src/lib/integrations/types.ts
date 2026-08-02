import type { IntegrationSource } from "@/lib/db/schema";

// What a connector run reports back. The ROUTE owns telemetry writes
// (last_run_at, last_error, consecutive_failures on integration_sources) —
// connectors only do the I/O and report; keeping the writes in one place
// mirrors the single-writer doctrine everywhere else.
export type ConnectorResult = {
  ok: boolean;
  /** User-facing summary — lands in a toast, and in last_error on failure. */
  message: string;
  /** Documents fetched by this run (0 for the stub — no real feed yet). */
  documentsReceived: number;
};

// The seam real intake channels plug into: an SFTP poller, an inbound-email
// fetcher, an ERP API client. The schema (integration_sources.config per
// kind, telemetry columns) is ready; only implementations are stubbed.
export interface IntegrationConnector {
  /** Cheap reachability check — config validity, credentials, connectivity. */
  testConnection(source: IntegrationSource): Promise<ConnectorResult>;
  /** One on-demand intake pass ("Run now" on the Data page). */
  runNow(source: IntegrationSource): Promise<ConnectorResult>;
}
