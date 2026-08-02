import type { IntegrationKind } from "@/lib/db/schema";

import { StubIntegrationConnector } from "./stub-connector";
import type { IntegrationConnector } from "./types";

// Every kind maps to the stub today; real connectors land here one kind at
// a time (an SFTP poller, an email-inbox fetcher, an ERP client) without
// touching the route or the Data page. The exhaustive switch makes a new
// kind a compile error, not a silent stub.
export function getConnector(kind: IntegrationKind): IntegrationConnector {
  switch (kind) {
    case "manual_upload":
    case "sftp":
    case "email_inbox":
    case "erp":
      return new StubIntegrationConnector();
  }
}

export type { ConnectorResult, IntegrationConnector } from "./types";
