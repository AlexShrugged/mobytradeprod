// Org-rule blast radius for the AI re-analysis queue, pure. A rule change
// re-runs the analyst over the entries the rule can affect, and every run
// is a real model investigation, so the set has to be as small as the rule
// allows. Two sources of scope:
//
//   - the structured suppression spec, line-level, through the auditor's
//     own lineMatchesScope so the two layers never disagree on a scope;
//   - references in the rule TEXT: HTS codes, countries of origin,
//     suppliers/vendors, SKUs, entry numbers. Text references resolve
//     against the analyzed entries' own facts — only a supplier, SKU, or
//     country the book actually contains can be a reference — so free
//     text narrows the set without a model call.
//
// Axes AND together (a rule naming a supplier and a country is about that
// supplier's goods from that country); values within an axis OR. A
// pattern-detected code that resolves to no entry is noise ("since
// 2025.01 ...") and is dropped rather than emptying the set. No references
// and no scoped spec means the rule is about the whole book: everything
// re-runs, exactly as before this existed.
//
// Vocabulary matches fail toward WIDER: a single-word supplier or country
// only counts when the text capitalizes it (a supplier named "Giant" is
// not the word "giant"), and a pure-alpha SKU only in all caps. A missed
// reference costs a few extra runs; a false one silently skips entries.
//
// Relative imports and no "server-only" on purpose: the queue calls this
// from route handlers and tsx scripts alike.

import { isUnscoped, lineMatchesScope } from "../audit/suppression";
import { normalizeHtsPrefix, type SuppressionSpec } from "../org-rules";
import { normalizeSku } from "../parts/sku";

export type RelevanceLine = {
  supplierName: string | null;
  /** The linked vendor's name, when the line resolved to one. */
  vendorName: string | null;
  countryOfOrigin: string | null;
  htsCodeDigits: string;
  /** Digit-normalized headings on the line's declared charges (Ch99). */
  chargeHtsDigits: string[];
  /** The declared SKU plus tariff-sheet SKUs (entry_line_parts). */
  skus: string[];
};

export type RelevanceEntry = {
  entryId: string;
  entryNumber: string;
  lines: RelevanceLine[];
  /** Open deterministic alert types — read by the model scoping pass
   *  (rule-scope.ts), never by the literal matcher below. */
  openAlertTypes?: string[];
  /** Open AI findings, same audience. */
  openFindings?: { category: string; title: string }[];
};

/** One rule state the change involved (before and/or after). */
export type OrgRuleState = {
  text: string;
  suppression: SuppressionSpec | null;
};

/** Text references that resolved against the entries. */
export type RuleReferences = {
  /** Digit-normalized prefixes; each matches some line or charge heading. */
  htsPrefixes: string[];
  /** ISO-2 codes some line declares. */
  countries: string[];
  /** Casefolded supplier/vendor names some line carries. */
  suppliers: string[];
  /** Normalized SKUs some line carries. */
  skus: string[];
  /** Digit-only entry numbers in the set. */
  entryNumbers: string[];
};

export type RuleReach = { all: true } | { all: false; entryIds: string[] };

const casefold = (s: string) => s.trim().toLowerCase();
const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Casefolded words separated by single spaces — the phrase space every
 *  name comparison happens in. */
const normalizePhrase = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// --- Text index -----------------------------------------------------------

type TextIndex = {
  /** " w1 w2 ... " so a phrase match is always whole-word. */
  padded: string;
  /** Casefolded words that appear with an uppercase first letter. */
  capitalized: Set<string>;
  /** Words that appear in all caps (2+ letters). */
  upper: Set<string>;
  /** Whitespace-delimited tokens with trailing punctuation stripped,
   *  uppercased — SKUs keep their hyphens/slashes/dots this way. */
  skuTokens: Set<string>;
};

function indexText(text: string): TextIndex {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const capitalized = new Set<string>();
  const upper = new Set<string>();
  for (const w of words) {
    const first = w[0];
    if (first !== first.toLowerCase()) capitalized.add(w.toLowerCase());
    if (w.length >= 2 && /^\p{Lu}+$/u.test(w)) upper.add(w);
  }
  const skuTokens = new Set<string>();
  for (const raw of text.split(/[\s,;()[\]"']+/)) {
    const tok = raw.replace(/[.,;:!?]+$/, "").toUpperCase();
    if (tok) skuTokens.add(tok);
  }
  return {
    padded: ` ${words.map((w) => w.toLowerCase()).join(" ")} `,
    capitalized,
    upper,
    skuTokens,
  };
}

/** A single word must appear capitalized; a multi-word phrase matches
 *  casefolded whole-word. */
function phraseMatches(index: TextIndex, phrase: string): boolean {
  if (!phrase) return false;
  if (!phrase.includes(" ")) return index.capitalized.has(phrase);
  return index.padded.includes(` ${phrase} `);
}

// --- HTS codes ------------------------------------------------------------

// Dotted codes the way a schedule prints them: 8714.10, 8714.10.00,
// 9903.01.25, 8714.10.0050. Bare digit runs only behind a label so a plain
// number ("2 of 4000 units") is never a code.
const DOTTED_HTS = /\b\d{4}(?:\.\d{2,4}){1,3}\b/g;
const LABELED_HTS =
  /\b(?:hts(?:us)?|heading|subheading|tariff(?:\s+code)?|classified\s+under|classification)\s*(?:#|no\.?|code)?\s*:?\s*(\d{4,10})\b/gi;

function htsCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(DOTTED_HTS)) out.add(normalizeHtsPrefix(m[0]));
  for (const m of text.matchAll(LABELED_HTS)) out.add(m[1]);
  return [...out].filter((d) => d.length >= 4);
}

const lineUnderPrefix = (line: RelevanceLine, prefix: string): boolean =>
  line.htsCodeDigits.startsWith(prefix) ||
  line.chargeHtsDigits.some((d) => d.startsWith(prefix));

// --- Countries ------------------------------------------------------------

// Variants a rule author types that the ICU region name does not cover:
// demonyms, abbreviations, old names. Keyed by ISO-2; only codes the
// entries actually declare are ever consulted.
const COUNTRY_ALIASES: Record<string, string[]> = {
  AE: ["uae", "emirati", "emirates"],
  AR: ["argentine", "argentinian"],
  AT: ["austrian"],
  AU: ["australian"],
  BD: ["bangladeshi"],
  BE: ["belgian"],
  BR: ["brazilian"],
  CA: ["canadian"],
  CH: ["swiss"],
  CL: ["chilean"],
  CN: ["prc", "chinese", "mainland china", "people's republic of china"],
  CO: ["colombian"],
  CZ: ["czech", "czech republic"],
  DE: ["german"],
  DK: ["danish"],
  EG: ["egyptian"],
  ES: ["spanish"],
  FI: ["finnish"],
  FR: ["french"],
  GB: ["uk", "u.k.", "britain", "british", "england", "great britain"],
  GR: ["greek"],
  HK: ["hong kong"],
  HU: ["hungarian"],
  ID: ["indonesian"],
  IE: ["irish"],
  IL: ["israeli"],
  IN: ["indian"],
  IT: ["italian"],
  JP: ["japanese"],
  KH: ["cambodian"],
  KR: ["korea", "korean", "south korean", "republic of korea"],
  LK: ["sri lankan"],
  MM: ["burma", "burmese"],
  MO: ["macau"],
  MX: ["mexican"],
  MY: ["malaysian"],
  NL: ["dutch", "holland"],
  NO: ["norwegian"],
  NZ: ["kiwi"],
  PE: ["peruvian"],
  PH: ["philippine", "filipino"],
  PK: ["pakistani"],
  PL: ["polish"],
  PT: ["portuguese"],
  RO: ["romanian"],
  RU: ["russian"],
  SE: ["swedish"],
  SG: ["singaporean"],
  TH: ["thai"],
  TR: ["turkey", "turkish", "türkiye"],
  TW: ["taiwanese", "chinese taipei"],
  US: ["usa", "u.s.", "u.s.a.", "american", "united states of america"],
  VN: ["viet nam", "vietnamese"],
  ZA: ["south african"],
};

// Bare ISO-2 tokens that are also English words: a name still resolves
// these countries, the two-letter code alone never does.
const CODE_STOPLIST = new Set([
  "AM", "AN", "AS", "AT", "BE", "BY", "DO", "GO", "HE", "ID", "IF", "IN",
  "IS", "IT", "ME", "MY", "NO", "OF", "OK", "ON", "OR", "SO", "TO", "UP",
  "US", "WE",
]);

let regionNames: Intl.DisplayNames | null | undefined;
function regionName(code: string): string | null {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    const name = regionNames?.of(code) ?? null;
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

function countryPhrases(code: string): string[] {
  const phrases = new Set<string>();
  const name = regionName(code);
  if (name) phrases.add(normalizePhrase(name));
  for (const alias of COUNTRY_ALIASES[code] ?? []) {
    phrases.add(normalizePhrase(alias));
  }
  phrases.delete("");
  return [...phrases];
}

function countryMentioned(index: TextIndex, code: string): boolean {
  if (!CODE_STOPLIST.has(code) && index.upper.has(code)) return true;
  return countryPhrases(code).some((p) => phraseMatches(index, p));
}

// --- Suppliers ------------------------------------------------------------

const CORPORATE_SUFFIXES = new Set([
  "co", "company", "ltd", "limited", "ltda", "inc", "incorporated", "corp",
  "corporation", "llc", "llp", "lp", "plc", "gmbh", "ag", "kk", "sa", "sas",
  "sarl", "srl", "spa", "sl", "bv", "nv", "pte", "pty", "sdn", "bhd", "oy",
  "ab", "as", "cc",
]);

// Words that name a kind of company, not the company: alone they never
// identify a supplier ("Technology" is not Shenzhen Foo Technology).
const GENERIC_NAME_WORDS = new Set([
  "technology", "technologies", "tech", "industry", "industries",
  "industrial", "trading", "trade", "manufacturing", "manufacturer",
  "international", "import", "imports", "export", "exports", "group",
  "enterprise", "enterprises", "electronics", "electronic", "products",
  "product", "machinery", "equipment", "holdings", "holding", "global",
  "systems", "solutions", "supply", "supplies", "factory", "city",
  "province", "development", "commercial", "commerce", "logistics",
  "hardware", "metal", "metals", "plastics", "textile", "textiles",
]);

/** The phrases a rule author would type for a supplier: the name with
 *  corporate suffixes stripped, its first two words ("Shenzhen Foo" for
 *  "SHENZHEN FOO TECHNOLOGY CO., LTD."), and each distinctive word on its
 *  own ("Giant" for "Giant Manufacturing Co Ltd" — single words match only
 *  when the text capitalizes them). Short cores are skipped. */
function supplierPhrases(name: string): string[] {
  const tokens = normalizePhrase(name).split(" ").filter(Boolean);
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  if (tokens.length > 1 && tokens[0] === "the") tokens.shift();
  if (tokens.length === 0) return [];
  const phrases = new Set<string>();
  if (tokens.length > 1) {
    phrases.add(tokens.join(" "));
    const lead = tokens.slice(0, 2).join(" ");
    if (lead.length - 1 >= 6) phrases.add(lead);
  }
  for (const token of tokens) {
    if (token.length >= 4 && !GENERIC_NAME_WORDS.has(token)) phrases.add(token);
  }
  return [...phrases];
}

const lineSupplierKeys = (line: RelevanceLine): string[] =>
  [line.supplierName, line.vendorName]
    .filter((s): s is string => !!s && s.trim() !== "")
    .map(casefold);

// --- SKUs -----------------------------------------------------------------

/** A SKU is matchable when it cannot be mistaken for prose: 3+ chars, a
 *  pure number only at 5+ digits, and a pure-alpha SKU only in all caps. */
function skuMentioned(index: TextIndex, sku: string): boolean {
  if (sku.length < 3) return false;
  if (/^\d+$/.test(sku) && sku.length < 5) return false;
  if (!index.skuTokens.has(sku)) return false;
  if (/^[A-Z]+$/.test(sku)) return index.upper.has(sku);
  return true;
}

// --- Entry numbers --------------------------------------------------------

const ENTRY_NUMBER = /\b\d{3}-?\d{7}-?\d\b/g;

// --- Extraction -----------------------------------------------------------

/** Every text reference that resolves against the entries. Vocabulary
 *  axes (countries, suppliers, SKUs, entry numbers) resolve by
 *  construction; HTS candidates are kept only when some line or charge
 *  heading falls under them. */
export function extractRuleReferences(
  text: string,
  entries: RelevanceEntry[],
): RuleReferences {
  const index = indexText(text);
  const lines = entries.flatMap((e) => e.lines);

  const htsPrefixes = htsCandidates(text).filter((prefix) =>
    lines.some((line) => lineUnderPrefix(line, prefix)),
  );

  const countryCodes = new Set<string>();
  const supplierNames = new Map<string, string>(); // casefold key → display
  const skus = new Set<string>();
  for (const line of lines) {
    if (line.countryOfOrigin) countryCodes.add(line.countryOfOrigin.toUpperCase());
    for (const name of [line.supplierName, line.vendorName]) {
      if (name && name.trim() !== "") supplierNames.set(casefold(name), name);
    }
    for (const sku of line.skus) {
      const key = normalizeSku(sku);
      if (key) skus.add(key);
    }
  }

  const countries = [...countryCodes].filter((code) =>
    countryMentioned(index, code),
  );
  const suppliers = [...supplierNames].flatMap(([key, name]) =>
    supplierPhrases(name).some((p) => phraseMatches(index, p)) ? [key] : [],
  );
  const matchedSkus = [...skus].filter((sku) => skuMentioned(index, sku));

  const entryDigits = new Set(entries.map((e) => digitsOf(e.entryNumber)));
  const entryNumbers = [
    ...new Set(
      [...text.matchAll(ENTRY_NUMBER)]
        .map((m) => digitsOf(m[0]))
        .filter((d) => entryDigits.has(d)),
    ),
  ];

  return { htsPrefixes, countries, suppliers, skus: matchedSkus, entryNumbers };
}

const hasReferences = (refs: RuleReferences): boolean =>
  refs.htsPrefixes.length > 0 ||
  refs.countries.length > 0 ||
  refs.suppliers.length > 0 ||
  refs.skus.length > 0 ||
  refs.entryNumbers.length > 0;

/** Every resolved axis must be satisfied somewhere on the entry; the
 *  structured spec is a per-line filter beside them. */
function entryMatches(
  entry: RelevanceEntry,
  spec: SuppressionSpec | null,
  refs: RuleReferences,
): boolean {
  if (spec !== null && !isUnscoped(spec)) {
    if (!entry.lines.some((line) => lineMatchesScope(line, spec))) return false;
  }
  if (
    refs.entryNumbers.length > 0 &&
    !refs.entryNumbers.includes(digitsOf(entry.entryNumber))
  ) {
    return false;
  }
  if (
    refs.htsPrefixes.length > 0 &&
    !entry.lines.some((line) =>
      refs.htsPrefixes.some((prefix) => lineUnderPrefix(line, prefix)),
    )
  ) {
    return false;
  }
  if (
    refs.countries.length > 0 &&
    !entry.lines.some(
      (line) =>
        line.countryOfOrigin !== null &&
        refs.countries.includes(line.countryOfOrigin.toUpperCase()),
    )
  ) {
    return false;
  }
  if (
    refs.suppliers.length > 0 &&
    !entry.lines.some((line) =>
      lineSupplierKeys(line).some((key) => refs.suppliers.includes(key)),
    )
  ) {
    return false;
  }
  if (
    refs.skus.length > 0 &&
    !entry.lines.some((line) =>
      line.skus.some((sku) => {
        const key = normalizeSku(sku);
        return key !== null && refs.skus.includes(key);
      }),
    )
  ) {
    return false;
  }
  return true;
}

/** The entries one rule state can affect: everything when neither the
 *  spec nor the text scopes it, otherwise the entries satisfying every
 *  axis. */
export function entriesTouchedByRule(
  state: OrgRuleState,
  entries: RelevanceEntry[],
): RuleReach {
  const refs = extractRuleReferences(state.text, entries);
  const specScoped =
    state.suppression !== null && !isUnscoped(state.suppression);
  if (!specScoped && !hasReferences(refs)) return { all: true };
  return {
    all: false,
    entryIds: entries
      .filter((entry) => entryMatches(entry, state.suppression, refs))
      .map((entry) => entry.entryId),
  };
}

/** Union over every rule state a change involved (the before state covers
 *  entries the rule stops applying to, the after state the ones it starts
 *  applying to). One unscoped state widens to everything. */
export function entriesTouchedByRules(
  states: OrgRuleState[],
  entries: RelevanceEntry[],
): RuleReach {
  const ids = new Set<string>();
  for (const state of states) {
    const reach = entriesTouchedByRule(state, entries);
    if (reach.all) return { all: true };
    for (const id of reach.entryIds) ids.add(id);
  }
  return { all: false, entryIds: [...ids] };
}
