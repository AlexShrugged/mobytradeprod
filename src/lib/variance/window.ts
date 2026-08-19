// Liquidation window estimate. Entries generally liquidate ~314 days after
// the entry date; there is no lifecycle feed yet, so the window is derived
// on read from the entry date alone and never stored. The same derivation
// yields the entry's phase: for 15 days after the entry date the summary
// can still be amended without a Post Summary Correction, so the entry
// counts as unsubmitted; after that it is submitted until it liquidates.

export const LIQUIDATION_WINDOW_DAYS = 314;
export const SUBMISSION_WINDOW_DAYS = 15;

export const ENTRY_PHASES = ["unsubmitted", "submitted", "liquidated"] as const;
export type EntryPhase = (typeof ENTRY_PHASES)[number];

/** Dropdown vocabulary for the Phase filters — shared by Variance and
 *  Entries so the two pages can never drift. */
export const PHASE_OPTIONS: {
  phase: EntryPhase;
  label: string;
  title?: string;
}[] = [
  {
    phase: "unsubmitted",
    label: "Unsubmitted",
    title: "Within 15 days of the entry date; still editable without a PSC",
  },
  { phase: "submitted", label: "Submitted" },
  {
    phase: "liquidated",
    label: "Liquidated",
    title: "The entry has liquidated",
  },
];

export type LiquidationWindow = {
  /** entryDate + 314 days, ISO; null when the entry has no date. */
  estDate: string | null;
  /** Calendar days from today to estDate (negative = past the estimate);
   *  null when the window is closed or there is no date. */
  daysLeft: number | null;
  /** The entry has actually liquidated — the window is history. */
  closed: boolean;
  /** Unsubmitted while today is within SUBMISSION_WINDOW_DAYS of the entry
   *  date (still editable without a PSC); dateless entries are submitted —
   *  there is no date to hold the edit window open from. */
  phase: EntryPhase;
  /** When the phase advances: the first day edits need a PSC for an
   *  unsubmitted entry (entryDate + 15, exact by rule), the liquidation
   *  estimate for a submitted one; null once liquidated (terminal) or
   *  when the entry has no date. */
  nextPhaseDate: string | null;
  /** Calendar days from today to nextPhaseDate — the phase-aware countdown:
   *  days until submission for an unsubmitted entry, days to the liquidation
   *  estimate (same as daysLeft) for a submitted one; null whenever
   *  nextPhaseDate is null. */
  nextPhaseDaysLeft: number | null;
};

const DAY_MS = 86_400_000;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function liquidationWindow(
  entryDate: string | null,
  status: string,
  todayIso: string,
): LiquidationWindow {
  const closed = status === "liquidated";
  if (!entryDate)
    return {
      estDate: null,
      daysLeft: null,
      closed,
      phase: closed ? "liquidated" : "submitted",
      nextPhaseDate: null,
      nextPhaseDaysLeft: null,
    };
  const entryMs = Date.parse(`${entryDate}T00:00:00Z`);
  const estMs = entryMs + LIQUIDATION_WINDOW_DAYS * DAY_MS;
  const estDate = isoDay(estMs);
  if (closed)
    return {
      estDate,
      daysLeft: null,
      closed,
      phase: "liquidated",
      nextPhaseDate: null,
      nextPhaseDaysLeft: null,
    };
  const todayMs = Date.parse(`${todayIso}T00:00:00Z`);
  const unsubmitted = (todayMs - entryMs) / DAY_MS < SUBMISSION_WINDOW_DAYS;
  const nextPhaseMs = unsubmitted
    ? entryMs + SUBMISSION_WINDOW_DAYS * DAY_MS
    : estMs;
  return {
    estDate,
    daysLeft: Math.round((estMs - todayMs) / DAY_MS),
    closed,
    phase: unsubmitted ? "unsubmitted" : "submitted",
    nextPhaseDate: isoDay(nextPhaseMs),
    nextPhaseDaysLeft: Math.round((nextPhaseMs - todayMs) / DAY_MS),
  };
}
