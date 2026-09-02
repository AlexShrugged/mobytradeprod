// The Claude scoping pass over an org-rule change: which analyzed entries
// could the rule change a judgment on? It sits ON TOP of the deterministic
// pass in rule-relevance.ts, which stays the floor — an entry the rule text
// literally names is re-run whether or not the model lists it. The model
// earns its keep in two places the literal pass cannot reach:
//
//   - shrinking "everything": a rule that names nothing literal ("packing
//     list weights are unreliable") re-runs the whole book today; the
//     model may narrow it to the entries it can see the rule touching,
//     with an explicit "all" it MUST take for genuinely entry-wide rules
//     (broker conduct, MPF, valuation doctrine);
//   - widening a named set: a variant supplier spelling, a product family
//     the rule describes rather than names, a related heading.
//
// The merge (mergeReach) encodes the coverage doctrine: the named floor is
// never shrunk, "everything" shrinks only to a non-empty pick, and every
// failure — no key, refusal, malformed reply, deadline, an oversized book
// — falls back to the deterministic reach. A missed entry costs one extra
// investigation; a wrongly skipped one keeps stale findings.
//
// Relative imports, no "server-only": the queue calls this from route
// handlers and tsx scripts alike.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import type {
  OrgRuleState,
  RelevanceEntry,
  RuleReach,
} from "./rule-relevance";

const DEFAULT_MODEL = "claude-opus-5";
// Per attempt; the client retries once (429/529/timeout), so the pass is
// bounded at ~2× this. The org-rule routes run it in after() ahead of the
// AFTER_RESPONSE_DRAIN (60s of claims + a 600s analyst deadline) and the
// whole thing must fit their maxDuration 800.
const DEFAULT_DEADLINE_MS = 60_000;
/** Books past this size skip the model: the table would dominate the
 *  prompt, and the deterministic reach is the designed fallback. */
const DEFAULT_MAX_ENTRIES = 400;
const MAX_SKUS_PER_ENTRY = 12;
const MAX_FINDINGS_PER_ENTRY = 8;

/** One rule change: `before` null = created, `after` null = deleted or
 *  disabled, both = edited (or an enable/disable flip with text). */
export type RuleChange = {
  before: OrgRuleState | null;
  after: OrgRuleState | null;
};

export type ScopeTableRow = {
  entryNumber: string;
  suppliers: string[];
  countries: string[];
  htsCodes: string[];
  chargeHeadings: string[];
  skus: string[];
  openAlerts: string[];
  openFindings: string[];
  /** True when the deterministic pass already selected the entry. */
  literalMatch: boolean;
};

export type ModelScope =
  | { all: true; reasoning: string }
  | {
      all: false;
      reasoning: string;
      picks: { entryId: string; entryNumber: string; reason: string }[];
    };

export interface RuleScoper {
  /** Null = no opinion (skipped, failed, refused): the caller keeps the
   *  deterministic reach. */
  scope(
    change: RuleChange,
    entries: RelevanceEntry[],
    deterministic: RuleReach,
  ): Promise<ModelScope | null>;
}

const scopeSchema = z.object({
  scope: z.enum(["all", "entries"]),
  reasoning: z.string(),
  entries: z.array(
    z.object({
      entryNumber: z.string(),
      reason: z.string(),
    }),
  ),
});

type ParsedScope = z.infer<typeof scopeSchema>;

const SYSTEM_PROMPT = `You scope an importer's rule change for an AI customs analyst. The importer records standing rules: guidance the analyst must follow, or suppressions of specific variance alerts. When a rule is created, edited, or removed, the analyst re-investigates the entries whose judgments the rule could change. Each re-investigation is expensive, so the set should be as small as correctness allows. But an entry left out keeps stale findings until something else touches it, so when in doubt, include.

You receive the change (the rule's text and structured scope before and after; a missing "before" is a new rule, a missing "after" is a removed or disabled one) and a table of the org's analyzed entries: entry number, suppliers, countries of origin, HTS codes, Chapter 99 charge headings, SKUs, open variance alerts (deterministic rule types), open AI findings, and whether literal matching already selected the entry.

Decide the scope:
- "all" when the rule bears on every entry: broker conduct, entry-level fees (MPF, HMF), valuation doctrine, document handling, general instructions about how to judge, anything not tied to identifiable goods, suppliers, origins, tariff programs, or specific entries. Never narrow such a rule to entries with open items; it can change the analyst's judgment on a clean entry too.
- "entries" when the rule's subject is identifiable and the table shows which entries carry it: a supplier, a country of origin, a heading or product family, a Chapter 99 program or exclusion claim, a SKU, or named entries. List every entry the rule could change a judgment on: where it could withdraw an open alert or finding, and where it could raise a new one. Entries literal matching already selected stay selected whatever you say; your job is what literal matching misses: a supplier under a variant spelling, a product family the rule describes rather than names, a related heading, a Chapter 99 claim the rule addresses. On an edit, include entries the rule stops applying to as well as ones it starts applying to.
- Prefer entries whose open alerts or findings the rule speaks to; a re-run changes something there. Skip entries the rule plainly cannot touch.

Give one short reason per entry, quote entry numbers exactly as given, and one line of reasoning for the scope choice.`;

/** The slice of the SDK client this scoper uses — injectable for tests. */
export interface ScopeParseClient {
  messages: {
    parse(
      params: {
        model: string;
        max_tokens: number;
        system: string;
        messages: { role: "user"; content: string }[];
        output_config: { format: unknown; effort?: string };
      },
      options?: { timeout?: number },
    ): Promise<{
      parsed_output: ParsedScope | null;
      stop_reason: string | null;
    }>;
  };
}

export class ClaudeRuleScoper implements RuleScoper {
  private readonly client: ScopeParseClient;
  readonly model: string;
  private readonly deadlineMs: number;
  private readonly maxEntries: number;

  constructor(
    opts: {
      client?: ScopeParseClient;
      model?: string;
      deadlineMs?: number;
      maxEntries?: number;
    } = {},
  ) {
    // The structural ScopeParseClient narrows the SDK surface to what we
    // call — the real client satisfies it at runtime; the cast bridges the
    // SDK's generic parse() signature (the extractor's pattern).
    this.client =
      opts.client ?? (new Anthropic({ maxRetries: 1 }) as unknown as ScopeParseClient);
    this.model = opts.model ?? process.env.RULE_SCOPE_MODEL ?? DEFAULT_MODEL;
    this.deadlineMs =
      opts.deadlineMs ??
      (Number(process.env.RULE_SCOPE_DEADLINE_MS) || DEFAULT_DEADLINE_MS);
    this.maxEntries =
      opts.maxEntries ??
      (Number(process.env.RULE_SCOPE_MAX_ENTRIES) || DEFAULT_MAX_ENTRIES);
  }

  async scope(
    change: RuleChange,
    entries: RelevanceEntry[],
    deterministic: RuleReach,
  ): Promise<ModelScope | null> {
    if (entries.length === 0) return null;
    if (entries.length > this.maxEntries) {
      console.warn(
        `[rule-scope] ${entries.length} entries exceed the ${this.maxEntries} cap; keeping the deterministic reach`,
      );
      return null;
    }
    const table = buildScopeTable(entries, deterministic);
    try {
      const response = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          messages: [
            { role: "user", content: buildUserContent(change, table, deterministic) },
          ],
          output_config: {
            format: zodOutputFormat(scopeSchema),
            effort: "medium",
          },
        },
        { timeout: this.deadlineMs },
      );
      // A refusal or an unparseable reply is "no opinion" — never a
      // narrower set than the deterministic pass found.
      if (response.stop_reason === "refusal" || !response.parsed_output) {
        return null;
      }
      return interpretScope(response.parsed_output, entries);
    } catch (err) {
      console.error(
        "[rule-scope] scoping call failed; keeping the deterministic reach:",
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
      return null;
    }
  }
}

/** The real scoper when a key is present, otherwise null — the queue then
 *  keeps the deterministic reach (fail wider, never a stub). */
export function getRuleScoper(): RuleScoper | null {
  return process.env.ANTHROPIC_API_KEY ? new ClaudeRuleScoper() : null;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** 8714100050 → 8714.10.00.50; shorter digit runs dot what they have. */
export function dotHts(digits: string): string {
  const d = digitsOf(digits);
  if (d.length < 4) return digits;
  const parts = [d.slice(0, 4)];
  for (let i = 4; i < d.length; i += 2) parts.push(d.slice(i, i + 2));
  return parts.join(".");
}

const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

/** The compact per-entry rows the model reads. Charge headings keep only
 *  Chapter 99 (base-duty and fee codes repeat the line HTS or say nothing);
 *  SKU and finding lists are capped so one sprawling entry cannot crowd
 *  the prompt. */
export function buildScopeTable(
  entries: RelevanceEntry[],
  deterministic: RuleReach,
): ScopeTableRow[] {
  const literal = deterministic.all ? null : new Set(deterministic.entryIds);
  return entries.map((entry) => {
    const lines = entry.lines;
    const skus = unique(lines.flatMap((l) => l.skus).map((s) => s.trim()).filter(Boolean));
    const findings = (entry.openFindings ?? []).map(
      (f) => `${f.category}: ${f.title}`,
    );
    return {
      entryNumber: entry.entryNumber,
      suppliers: unique(
        lines
          .flatMap((l) => [l.supplierName, l.vendorName])
          .filter((s): s is string => !!s && s.trim() !== "")
          .map((s) => s.trim()),
      ),
      countries: unique(
        lines
          .map((l) => l.countryOfOrigin)
          .filter((c): c is string => !!c)
          .map((c) => c.toUpperCase()),
      ),
      htsCodes: unique(lines.map((l) => dotHts(l.htsCodeDigits))),
      chargeHeadings: unique(
        lines
          .flatMap((l) => l.chargeHtsDigits)
          .filter((d) => d.startsWith("99"))
          .map(dotHts),
      ),
      skus: skus.slice(0, MAX_SKUS_PER_ENTRY),
      openAlerts: unique(entry.openAlertTypes ?? []),
      openFindings: findings.slice(0, MAX_FINDINGS_PER_ENTRY),
      literalMatch: literal === null ? false : literal.has(entry.entryId),
    };
  });
}

function buildUserContent(
  change: RuleChange,
  table: ScopeTableRow[],
  deterministic: RuleReach,
): string {
  const kind =
    change.before === null
      ? "created"
      : change.after === null
        ? "removed"
        : "edited";
  return JSON.stringify({
    change: { kind, before: change.before, after: change.after },
    literalMatch: deterministic.all
      ? "nothing literal was named; the default is every entry"
      : `${deterministic.entryIds.length} of ${table.length} entries, marked literalMatch`,
    entries: table,
  });
}

/** Map the model's entry numbers back onto ids (hyphen-insensitive);
 *  numbers that name no entry are dropped. */
export function interpretScope(
  parsed: ParsedScope,
  entries: RelevanceEntry[],
): ModelScope {
  if (parsed.scope === "all") return { all: true, reasoning: parsed.reasoning };
  const byDigits = new Map(entries.map((e) => [digitsOf(e.entryNumber), e]));
  const seen = new Set<string>();
  const picks: { entryId: string; entryNumber: string; reason: string }[] = [];
  for (const pick of parsed.entries) {
    const entry = byDigits.get(digitsOf(pick.entryNumber));
    if (!entry || seen.has(entry.entryId)) continue;
    seen.add(entry.entryId);
    picks.push({
      entryId: entry.entryId,
      entryNumber: entry.entryNumber,
      reason: pick.reason,
    });
  }
  return { all: false, reasoning: parsed.reasoning, picks };
}

/**
 * The coverage doctrine in one place. The deterministic reach is the
 * floor: a named set is never shrunk, only widened by the model's picks
 * (or to everything). "Everything" — nothing named — is the one set the
 * model may shrink, and only to a non-empty pick: an empty pick, a
 * refusal, or no opinion at all keeps everything.
 */
export function mergeReach(
  deterministic: RuleReach,
  model: ModelScope | null,
): RuleReach {
  if (model === null) return deterministic;
  if (deterministic.all) {
    if (model.all || model.picks.length === 0) return { all: true };
    return { all: false, entryIds: unique(model.picks.map((p) => p.entryId)) };
  }
  if (model.all) return { all: true };
  return {
    all: false,
    entryIds: unique([
      ...deterministic.entryIds,
      ...model.picks.map((p) => p.entryId),
    ]),
  };
}
