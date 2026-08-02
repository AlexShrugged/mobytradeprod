// The pure review status machine for HTS classification decisions. No DB —
// service.ts executes the returned effects in one transaction. Semantics
// are legacy-verified: soft-reject clears only provisional auto-selects
// (a committed code survives a rejected suggestion), and "needs
// acknowledge" is a proposal kind, not a queue status, so the queue's
// status machine stays generic for future review item types.

import { normalizeHts } from "../duty/calculator";
import type { ClassifyResult } from "./types";

export type ReviewKind = "suggestion" | "confirmation";

// Mirror of parts.hts_review_status values (schema is not imported here to
// keep this module dependency-free for tests).
export type PartReviewStatus =
  | "pending"
  | "confirmed"
  | "accepted"
  | "rejected"
  | "acknowledged";

export type ReviewActionInput =
  | { action: "accept"; code: string }
  | { action: "manual"; code: string }
  | { action: "reject" }
  | { action: "acknowledge" }
  | { action: "reopen" };

export type ReviewState = {
  partStatus: PartReviewStatus;
  /** parts.hts_code_provisional — the current code was auto-selected. */
  provisional: boolean;
  kind: ReviewKind;
};

export type ReviewEffect = {
  nextPartStatus: PartReviewStatus;
  nextItemStatus: "pending" | "approved" | "rejected";
  /** Non-null: write this code to parts.hts_code and clear provisional. */
  commitCode: string | null;
  /** Reject of a provisional auto-select: revert parts.hts_code to null. */
  clearProvisional: boolean;
};

const OPEN_STATUSES: PartReviewStatus[] = ["pending", "confirmed"];

export function applyReviewAction(
  current: ReviewState,
  input: ReviewActionInput,
): ReviewEffect {
  const open = OPEN_STATUSES.includes(current.partStatus);

  switch (input.action) {
    case "accept": {
      if (!open || current.kind !== "suggestion") {
        throw new Error(
          `Cannot accept: item is ${current.partStatus}/${current.kind} (accept applies to open suggestions; confirmations are acknowledged)`,
        );
      }
      return {
        nextPartStatus: "accepted",
        nextItemStatus: "approved",
        commitCode: assertValidCommitCode(input.code),
        clearProvisional: false,
      };
    }
    case "manual": {
      if (!open) {
        throw new Error(
          `Cannot apply a manual code: item is ${current.partStatus}`,
        );
      }
      return {
        nextPartStatus: "accepted",
        nextItemStatus: "approved",
        commitCode: assertValidCommitCode(input.code),
        clearProvisional: false,
      };
    }
    case "acknowledge": {
      if (!open || current.kind !== "confirmation") {
        throw new Error(
          `Cannot acknowledge: item is ${current.partStatus}/${current.kind} (acknowledge applies to open confirmations)`,
        );
      }
      return {
        nextPartStatus: "acknowledged",
        nextItemStatus: "approved",
        commitCode: null,
        clearProvisional: false,
      };
    }
    case "reject": {
      if (!open || current.kind !== "suggestion") {
        throw new Error(
          `Cannot reject: item is ${current.partStatus}/${current.kind} (a confirmation of the current code is acknowledged or overridden manually)`,
        );
      }
      return {
        nextPartStatus: "rejected",
        nextItemStatus: "rejected",
        commitCode: null,
        // Soft-reject: only an unreviewed auto-select is reverted.
        clearProvisional: current.provisional,
      };
    }
    case "reopen": {
      if (current.partStatus !== "rejected") {
        throw new Error(
          `Cannot reopen: item is ${current.partStatus} (only rejected items reopen; re-run classification to supersede a decided one)`,
        );
      }
      return {
        nextPartStatus: current.kind === "confirmation" ? "confirmed" : "pending",
        nextItemStatus: "pending",
        commitCode: null,
        clearProvisional: false,
      };
    }
  }
}

/** Shared by review actions and the direct-edit path in service.ts. */
export function assertValidCommitCode(code: string): string {
  const digits = normalizeHts(code);
  if (digits.length !== 8 && digits.length !== 10) {
    throw new Error(
      `Invalid HTS code "${code}" — expected 8 or 10 digits, got ${digits.length}`,
    );
  }
  if (digits.startsWith("98") || digits.startsWith("99")) {
    throw new Error(
      `Invalid HTS code "${code}" — chapter 98/99 codes are program overlays, not product classifications`,
    );
  }
  return code;
}

export type InitialReview = {
  kind: ReviewKind;
  partStatus: "pending" | "confirmed";
  /** Fill an empty catalog slot with the certain suggestion, marked
   *  provisional. Never fires when any committed code exists. */
  autoSelectProvisional: boolean;
};

/**
 * What a fresh classification result means for the queue. Null = no review
 * item (nothing found). A certain match of the committed code is a
 * confirmation; anything else needing eyes is a suggestion.
 */
export function deriveInitialReview(
  result: ClassifyResult,
  currentCommittedDigits: string | null,
): InitialReview | null {
  if (result.outcome === "none" || result.candidates.length === 0) return null;

  const primary = result.candidates[0];
  if (
    result.outcome === "certain" &&
    currentCommittedDigits !== null &&
    primary.codeDigits === currentCommittedDigits
  ) {
    return {
      kind: "confirmation",
      partStatus: "confirmed",
      autoSelectProvisional: false,
    };
  }

  return {
    kind: "suggestion",
    partStatus: "pending",
    autoSelectProvisional:
      currentCommittedDigits === null && result.outcome === "certain",
  };
}
