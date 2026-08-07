// Pure refund-claim helpers, safe to import from client components.

export type RefundStage = "rejected" | "paid" | "pending_payout" | "processing";

/**
 * Collapse the two independent lifecycle signals into a display stage.
 * claim_status is the CBP decision; refund_status is the payout state.
 * Precedence (legacy-verified): rejected > paid > pending_payout >
 * processing.
 */
export function deriveRefundStage(
  claimStatus: string | null,
  refundStatus: string | null,
): RefundStage {
  if (claimStatus && /reject|deni/i.test(claimStatus)) return "rejected";
  if (refundStatus && /transmit|paid/i.test(refundStatus)) return "paid";
  if (claimStatus && /accept/i.test(claimStatus)) return "pending_payout";
  return "processing";
}

/** "300-1234567-8" -> "30012345678" — the cross-system matching key. */
export function normalizeEntryNumber(entryNumber: string): string {
  return entryNumber.replace(/\D/g, "");
}
