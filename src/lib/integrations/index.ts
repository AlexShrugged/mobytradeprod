import type { IntegrationKind } from "@/lib/db/schema";
import { isProdRuntime } from "@/lib/env";

import { StubIntegrationConnector } from "./stub-connector";
import type { IntegrationConnector } from "./types";

// Every kind maps to the stub today; real connectors land here one kind at
// a time (an SFTP poller, an email-inbox fetcher) without touching the
// route or the Data page. The exhaustive switch makes a new kind a compile
// error, not a silent stub. On Vercel the stub is refused for every kind —
// it fabricates documents, and manual_upload never legitimately runs a
// connector. "erp" is retired from the UI but stays in the enum: dropping
// a Postgres enum value is destructive and existing rows may carry it.
export function getConnector(kind: IntegrationKind): IntegrationConnector {
  if (isProdRuntime()) {
    throw new Error(
      `No production connector exists for "${kind}" yet — the stub connector is dev-only.`,
    );
  }
  switch (kind) {
    case "manual_upload":
    case "sftp":
    case "email_inbox":
    case "erp":
      return new StubIntegrationConnector();
  }
}

export type { ConnectorResult, IntegrationConnector } from "./types";
