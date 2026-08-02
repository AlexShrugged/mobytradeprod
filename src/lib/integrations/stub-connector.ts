import type { IntegrationSource } from "@/lib/db/schema";
import type { ConnectorResult, IntegrationConnector } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Simulates a connector round-trip: ~600ms of "network", then success. Real
// connectors replace this class per kind; the route's telemetry writes
// (bumping last_run_at etc.) stay identical.
export class StubIntegrationConnector implements IntegrationConnector {
  async testConnection(source: IntegrationSource): Promise<ConnectorResult> {
    await sleep(600);
    return {
      ok: true,
      message: `Connection to ${source.name} looks good.`,
      documentsReceived: 0,
    };
  }

  async runNow(source: IntegrationSource): Promise<ConnectorResult> {
    await sleep(600);
    return {
      ok: true,
      message: `${source.name} checked — no new documents.`,
      documentsReceived: 0,
    };
  }
}
