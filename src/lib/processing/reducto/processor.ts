import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
  toFile,
} from "reductoai";

import { getFileStore } from "@/lib/storage";
import { mapSplitToManifest } from "../packet";
import type {
  DocumentProcessor,
  ExtractionResult,
  ProcessInput,
  ProcessOutput,
  RawExtraction,
} from "../types";
import { ProcessingError } from "../types";
import {
  dropMirroredQuantities,
  isLedgerFinding,
  reconcilePortEntry,
  reconcileRetryAddendum,
} from "../reconcile";
import { getReductoClient } from "./client";
import {
  classifyFromResponse,
  mapExtractToResult,
} from "./map";
import {
  CLASSIFICATION_SCHEMA,
  classificationPrompt,
  EXTRACT_SCHEMAS,
  SPLIT_CATEGORIES,
  SPLIT_RULES,
  SYSTEM_PROMPTS,
} from "./schemas";

// upload → parse once → extract twice against jobid:// (classification,
// then the type-specific schema). The full parse and both extract payloads
// are returned verbatim in `raw` so nothing the provider found is lost,
// even when it doesn't map into ExtractionResult.
//
// Two packet variations:
//   - entry_packet parents skip the typed extract and run split.run against
//     the parse job instead; the manifest is the extraction.
//   - packet children (input.packetRole set) parse only their pageRange of
//     the shared parent bytes and skip classification — the split role is
//     authoritative (classification has no assist-sheet vs invoice nuance),
//     and a child must never re-split. jobid:// inputs ignore parsing
//     config, so children re-upload and parse with settings.page_range
//     rather than page-scoping the parent's parse job.
export class ReductoDocumentProcessor implements DocumentProcessor {
  async process(input: ProcessInput): Promise<ProcessOutput> {
    const client = getReductoClient();
    const bytes = await getFileStore().get(input.storageKey);
    const isPacketChild = input.packetRole != null;

    // Filled in as stages complete so a late failure still surfaces the
    // already-paid-for payloads via ProcessingError.
    let parsePart: RawExtraction["parse"] | null = null;
    let classifyPart: RawExtraction["classify"] = null;
    let extractPart: RawExtraction["extract"] = null;
    let splitPart: RawExtraction["split"] = null;
    const envelope = (): RawExtraction | null =>
      parsePart && {
        provider: "reducto",
        parse: parsePart,
        classify: classifyPart,
        extract: extractPart,
        split: splitPart,
        retrievedAt: new Date().toISOString(),
      };

    try {
      const upload = await client.upload({
        file: await toFile(bytes, input.fileName, { type: input.mimeType }),
      });

      const parsed = await client.parse.run({
        input: upload.file_id,
        ...(isPacketChild && input.pageRange?.length
          ? { settings: { page_range: input.pageRange } }
          : {}),
      });
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

      let docType = input.docTypeHint;
      if (!isPacketChild && docType !== "entry_packet") {
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
        docType = classifyFromResponse(classified.result, input.docTypeHint);
      }

      let extraction: ExtractionResult;
      if (docType === "entry_packet") {
        // A child can't be a packet — the split role said otherwise, and
        // re-splitting would recurse.
        if (isPacketChild) {
          throw new ProcessingError(
            "A packet part cannot itself be an entry packet.",
          );
        }
        const split = await client.split.run({
          input: jobInput,
          split_description: SPLIT_CATEGORIES,
          split_rules: SPLIT_RULES,
        });
        splitPart = {
          jobId: null, // split responses carry no job id of their own
          usage: split.usage,
          response: split.result,
        };
        extraction = {
          docType: "entry_packet",
          fields: mapSplitToManifest(split.result.splits),
        };
      } else if (docType === "part_catalog") {
        // Unreachable: catalog imports are born processed and the process
        // route refuses them; classification can never return this type.
        throw new ProcessingError(
          "Part catalog imports apply on the Parts page, not through the document pipeline.",
        );
      } else if (docType === "other") {
        extraction = {
          docType: "other",
          fields: {
            note: "Document type could not be classified; full parsed content retained in raw extraction.",
            num_pages: parsed.usage.num_pages,
          },
        };
      } else {
        const runExtract = async (systemPrompt: string) => {
          const extracted = await client.extract.run({
            input: jobInput,
            instructions: {
              schema: EXTRACT_SCHEMAS[docType],
              system_prompt: systemPrompt,
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
          // The latest attempt's payload is the one retained — on a retry
          // it supersedes the first, matching what mapped (or failed).
          extractPart = {
            jobId: extracted.job_id ?? null,
            usage: extracted.usage,
            response: extracted.result,
          };
          return mapExtractToResult(docType, extracted.result);
        };
        extraction = await runExtract(SYSTEM_PROMPTS[docType]);
        // A 7501 is self-checking: rated duty charges print rate AND amount,
        // and the header prints the totals the lines must sum to. When the
        // mapped extraction contradicts that arithmetic (numbered lines
        // merged, an invoice-block subtotal taken as a line's entered value,
        // a dropped line), retry once with the findings spelled out, then
        // fail closed — a provably wrong duty ledger cascades into false
        // money variances if it persists as fact.
        if (extraction.docType === "port_entry") {
          const findings = reconcilePortEntry(extraction.fields);
          if (findings.length > 0) {
            extraction = await runExtract(
              `${SYSTEM_PROMPTS[docType]}\n\n${reconcileRetryAddendum(findings)}`,
            );
            const persisting =
              extraction.docType === "port_entry"
                ? reconcilePortEntry(extraction.fields)
                : [];
            if (persisting.some(isLedgerFinding)) {
              throw new ProcessingError(
                "Extraction contradicts the 7501's own printed duty math, " +
                  "even after a corrective retry. " +
                  persisting.map((f) => f.message).join(" "),
              );
            }
            // Only the soft finding survived: the money reconciles, and a
            // quantity that still mirrors the dollar value is blanked
            // rather than persisted as fact — unknown beats fabricated.
            if (persisting.length > 0 && extraction.docType === "port_entry") {
              extraction = {
                docType: "port_entry",
                fields: dropMirroredQuantities(extraction.fields, persisting),
              };
            }
          }
        }
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
