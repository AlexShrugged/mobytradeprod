// Tariff-sync domain types. The pipeline is fetch -> parse -> diff ->
// staged revisions in the review queue; nothing here ever writes the
// reference tables (that is apply.ts, behind human approval).

import type {
  AnnouncementSourceValue,
  HtsRateTypeValue,
  MeasureAuthorityValue,
  MeasureScopeValue,
  RevisionChangeTypeValue,
} from "../db/schema";

/** One Chapter 99 line from the USITC exportList JSON, normalized. */
export type Ch99Row = {
  htsno: string; // "9903.01.23"
  digits: string; // "99030123"
  description: string;
  general: string; // rate text, e.g. "The duty provided in the applicable subheading + 25%"
  special: string;
  additionalDuties: string;
  footnotes: string;
};

export type FrNotice = {
  documentNumber: string;
  title: string;
  htmlUrl: string;
  publicationDate: string; // ISO
  abstract: string | null;
  agencies: string[];
};

export type ParsedRate =
  | { kind: "additional"; rate: number } // "... + 25%"
  | { kind: "ad_valorem"; rate: number } // bare "25%"
  | { kind: "none" } // no surcharge: "Free", "No change", bare "The duty provided..."
  | { kind: "unparsed"; text: string }; // compound/specific — human fills

export type SailClauseKind =
  | "sail_before"
  | "sail_on_or_after"
  | "entry_before"
  | "entry_on_or_after";

/** A date phrase the highlighter found in Chapter 99 description text —
 *  evidence for the reviewer, never auto-applied. */
export type SailClauseCandidate = {
  kind: SailClauseKind;
  isoDate: string;
  snippet: string; // surrounding text for the <mark> render
  index: number; // character offset of the snippet in the source text
};

/** The full post-apply shape a revision proposes — measure_revisions.proposed.
 *  Date fields start null (the structured feed has none); the reviewer
 *  confirms them from the evidence highlights before approving. */
export type ProposedMeasureChange = {
  name: string;
  authority: MeasureAuthorityValue;
  scope: MeasureScopeValue;
  countries: string[] | null;
  effectiveDate: string | null;
  endDate: string | null;
  sailedOnOrAfter: string | null;
  sailedOnOrBefore: string | null;
  rate: number | null;
  exemption: boolean;
  inLieuOfBaseDuty: boolean;
  prefixes: string[];
  notes: string | null;
};

/** measure_revisions.evidence — what the reviewer sees. */
export type RevisionEvidence = {
  description: string;
  general: string;
  special: string;
  additionalDuties: string;
  footnotes: string;
  highlights: SailClauseCandidate[];
};

/** measure_revisions.live_snapshot — current state for the diff view. */
export type LiveMeasureSnapshot = {
  measureId: string;
  ch99Code: string; // dotted display form
  ch99Digits: string;
  name: string;
  authority: MeasureAuthorityValue;
  scope: MeasureScopeValue;
  countries: string[] | null;
  effectiveDate: string;
  endDate: string | null;
  sailedOnOrAfter: string | null;
  sailedOnOrBefore: string | null;
  rate: number | null;
  exemption: boolean;
  description: string;
  prefixes: string[];
};

export type ProposedRevision = {
  changeType: RevisionChangeTypeValue;
  ch99Code: string;
  authority: MeasureAuthorityValue;
  targetMeasureId: string | null;
  proposed: ProposedMeasureChange;
  evidence: RevisionEvidence;
  liveSnapshot: LiveMeasureSnapshot | null;
  contentHash: string;
};

/** Current reference state the differ compares a release against: the
 *  LATEST measure window per Chapter 99 digits. */
export type TariffSyncState = {
  byDigits: Map<string, LiveMeasureSnapshot>;
};

/** An open (pending review) revision, for hash-dedupe and supersession. */
export type OpenRevisionRef = {
  revisionId: string;
  reviewItemId: string;
  announcementId: string;
  ch99Digits: string | null;
  contentHash: string;
};

/** review_items.proposal for tariff_measure_revision items — the
 *  denormalized queue-list display payload. */
export type RevisionProposalDisplay = {
  changeType: RevisionChangeTypeValue;
  ch99Code: string | null;
  authority: MeasureAuthorityValue | null;
  name: string;
  rateBefore: number | null;
  rateAfter: number | null;
  source: AnnouncementSourceValue;
  sourceRef: string;
  announcementTitle: string;
};

// ------------------------------------------------------------ base schedule
//
// The base-schedule (chapters 1–97) refresh is the objective counterpart of
// the Chapter 99 review flow: ~30k rows of MFN rates that apply directly
// (no human gate) with per-code change-tiling windows on hts_codes.

/** One raw base-schedule line from the USITC exportList JSON, normalized.
 *  htsno may be "" — codeless decision-branch rows ("Other:") carry
 *  hierarchy context on the ETL's indent stack but never become db rows. */
export type BaseScheduleRow = {
  htsno: string; // "0101.21.00.10", "0101", or "" (codeless branch)
  indent: number;
  description: string;
  general: string; // column 1 general rate text; "" inherits from an ancestor
  special: string; // column 1 special (FTA parenthetical) text
  other: string; // column 2 rate text
  unitOfQuantity: string;
};

/** Column-1 general cell, classified. Free/ad-valorem carry a computable
 *  decimal-fraction rate; specific/compound/other rates display via the raw
 *  text but are not computed in v1. */
export type ParsedBaseRate = {
  rateType: HtsRateTypeValue;
  rate: number | null;
};

/** The current (valid_to null) base window per code — what the base ETL
 *  diffs a release against. */
export type CurrentBaseWindow = {
  codeDigits: string;
  code: string;
  description: string;
  rate: number | null;
  validFrom: string | null;
};

/** A fully resolved base-schedule row, ready to become an hts_codes window
 *  (hierarchy recovered, rate inherited where the row's own cells were
 *  blank). */
export type PreparedBaseRow = {
  code: string;
  codeDigits: string;
  chapter: number;
  description: string;
  indent: number;
  /** Nearest CODED ancestor in the indent tree (digits form). */
  parentDigits: string | null;
  rateType: HtsRateTypeValue;
  rate: number | null; // decimal fraction; null for specific/compound/other
  col1General: string | null;
  col1Special: string | null;
  col2Rate: string | null;
  unitOfQuantity: string | null;
  /** When this row's own rate cells were blank: digits of the rate-bearing
   *  ancestor the rate came from (null when that ancestor was codeless). */
  rateInheritedFrom: string | null;
};

/** Release-vs-live diff over the base schedule. `changed` = rate OR
 *  normalized description differs from the current window; absence from the
 *  release means removal (USITC publishes no change feed). */
export type BaseDiff = {
  added: PreparedBaseRow[];
  changed: { row: PreparedBaseRow; current: CurrentBaseWindow }[];
  removed: CurrentBaseWindow[];
  unchanged: number;
};
