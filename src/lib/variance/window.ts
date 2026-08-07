// Liquidation window estimate. Entries generally liquidate ~314 days after
// the entry date; there is no lifecycle feed yet, so the window is derived
// on read from the entry date alone and never stored.

export const LIQUIDATION_WINDOW_DAYS = 314;

export type LiquidationWindow = {
  /** entryDate + 314 days, ISO; null when the entry has no date. */
  estDate: string | null;
  /** Calendar days from today to estDate (negative = past the estimate);
   *  null when the window is closed or there is no date. */
  daysLeft: number | null;
  /** The entry has actually liquidated — the window is history. */
  closed: boolean;
};

const DAY_MS = 86_400_000;

export function liquidationWindow(
  entryDate: string | null,
  status: string,
  todayIso: string,
): LiquidationWindow {
  const closed = status === "liquidated";
  if (!entryDate) return { estDate: null, daysLeft: null, closed };
  const estMs =
    Date.parse(`${entryDate}T00:00:00Z`) + LIQUIDATION_WINDOW_DAYS * DAY_MS;
  const estDate = new Date(estMs).toISOString().slice(0, 10);
  if (closed) return { estDate, daysLeft: null, closed };
  const todayMs = Date.parse(`${todayIso}T00:00:00Z`);
  return { estDate, daysLeft: Math.round((estMs - todayMs) / DAY_MS), closed };
}
