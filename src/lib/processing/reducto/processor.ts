import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
  toFile,
} from "reductoai";

import { getFileStore } from "@/lib/storage";
import type {
  DocumentProcessor,
  ExtractionResult,
  ProcessInput,
  ProcessOutput,
  RawExtraction,
} from "../types";
import { ProcessingError } from "../types";
import { getReductoClient } from "./client";
import {
  classifyFromResponse,
  mapExtractToResult,
} from "./map";
import {
  CLASSIFICATION_SCHEMA,
  classificationPrompt,
  EXTRACT_SCHEMAS,
  SYSTEM_PROMPTS,
} from "./schemas";

// upload → parse once → extract twice against jobid:// (classification,
// then the type-specific schema). The full parse and both extract payloads
// are returned verbatim in `raw` so nothing the provider found is lost,
// even when it doesn't map into ExtractionResult.
export class ReductoDocumentProcessor implements DocumentProcessor {
  async process(input: ProcessInput): Promise<ProcessOutput> {
    const client = getReductoClient();
    const bytes = await getFileStore().get(input.storageKey);

    // Filled in as stages complete so a late failure still surfaces the
    // already-paid-for payloads via ProcessingError.
    let parsePart: RawExtraction["parse"] | null = null;
    let classifyPart: RawExtraction["classify"] = null;
    let extractPart: RawExtraction["extract"] = null;
    const envelope = (): RawExtraction | null =>
      parsePart && {
        provider: "reducto",
        parse: parsePart,
        classify: classifyPart,
        extract: extractPart,
        retrievedAt: new Date().toISOString(),
      };

    try {
      const upload = await client.upload({
        file: await toFile(bytes, input.fileName, { type: input.mimeType }),
      });

      const parsed = await client.parse.run({ input: upload.file_id });
      if (!("result" in parsed)) {
        throw new ProcessingError(
          "Reducto returned an async parse response for a sync request.",
        );
      }
      // URL-type results expire after an hour — fetch and inline now, or
      // the retained payload would be a dead link.
      const parseResult =
        parsed.result.type === "url"
          ? await fetchJson(parsed.result.url)
          : parsed.result;
      parsePart = {
        jobId: parsed.job_id,
        duration: parsed.duration,
        usage: parsed.usage,
        result: parseResult,
      };
      const jobInput = `jobid://${parsed.job_id}`;

      const classified = await client.extract.run({
        input: jobInput,
        instructions: {
          schema: CLASSIFICATION_SCHEMA,
          system_prompt: classificationPrompt(
            input.fileName,
            input.docTypeHint,
          ),
        },
      });
      if (!("result" in classified)) {
        throw new ProcessingError(
          "Reducto returned an async extract response for a sync request.",
        );
      }
      classifyPart = {
        jobId: classified.job_id ?? null,
        usage: classified.usage,
        response: classified.result,
      };
      const docType = classifyFromResponse(
        classified.result,
        input.docTypeHint,
      );

      let extraction: ExtractionResult;
      if (docType === "other") {
        extraction = {
          docType: "other",
          fields: {
            note: "Document type could not be classified; full parsed content retained in raw extraction.",
            num_pages: parsed.usage.num_pages,
          },
        };
      } else {
        const extracted = await client.extract.run({
          input: jobInput,
          instructions: {
            schema: EXTRACT_SCHEMAS[docType],
            system_prompt: SYSTEM_PROMPTS[docType],
          },
          settings: {
            citations: { enabled: true, numerical_confidence: true },
          },
        });
        if (!("result" in extracted)) {
          throw new ProcessingError(
            "Reducto returned an async extract response for a sync request.",
          );
        }
        extractPart = {
          jobId: extracted.job_id ?? null,
          usage: extracted.usage,
          response: extracted.result,
        };
        extraction = mapExtractToResult(docType, extracted.result);
      }

      const raw = envelope();
      if (!raw) throw new ProcessingError("Parse produced no payload.");
      return { extraction, raw };
    } catch (err) {
      throw translateError(err, envelope(), parsePart?.jobId ?? null);
    }
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new ProcessingError(
      `Failed to download the full parse result (HTTP ${res.status}).`,
    );
  }
  return res.json();
}

function translateError(
  err: unknown,
  raw: RawExtraction | null,
  parseJobId: string | null,
): ProcessingError {
  if (err instanceof ProcessingError) {
    // Re-wrap so the payloads gathered before the failure travel with it.
    return err.raw ? err : new ProcessingError(err.message, raw, parseJobId);
  }
  let message: string;
  if (err instanceof AuthenticationError) {
    message = "Reducto authentication failed — check REDUCTO_API_KEY.";
  } else if (err instanceof RateLimitError) {
    message = "Reducto rate limit reached — reprocess in a few minutes.";
  } else if (err instanceof APIConnectionError) {
    message = "Could not reach the Reducto API — check network connectivity.";
  } else if (err instanceof APIError) {
    message = `Reducto API error (${err.status ?? "unknown"}): ${err.message}`;
  } else {
    message =
      err instanceof Error ? err.message : "Processing failed unexpectedly.";
  }
  return new ProcessingError(message, raw, parseJobId);
}
