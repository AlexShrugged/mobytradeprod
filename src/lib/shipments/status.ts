// Shipment lifecycle state, DERIVED on read from date facts and the entry
// graph — never stored. The ingested documents (BOL, booking confirmation)
// state facts as of issuance and can never say "arrived", so a stored
// status column could only ever be seed fiction or go stale. Derivation:
//
//   arrived     an ingested ETA has passed (eta <= today), OR a customs
//               entry is linked to the shipment — a filed entry is direct
//               evidence the goods reached port.
//   in_transit  the BOL's shipped-on-board notation exists and has passed
//               (sailedOnBoardDate <= today). ETD deliberately does NOT
//               count: it is an estimate, and only the real laden date
//               proves sailing (same asymmetry the sail-window logic uses).
//   booked      everything else — the shipment is known (booking/BOL seen
//               or referenced by an entry) but nothing proves it sailed.
//
// "delivered" is gone: no document class we ingest carries proof of
// delivery, so it cannot be derived honestly.
//
// Relative imports on purpose — reachable from the tsx seed script.

export type DerivedShipmentStatus = "booked" | "in_transit" | "arrived";

export function deriveShipmentStatus(
  shipment: { sailedOnBoardDate: string | null; eta: string | null },
  hasLinkedEntry: boolean,
  today: string,
): DerivedShipmentStatus {
  if (hasLinkedEntry || (shipment.eta !== null && shipment.eta <= today)) {
    return "arrived";
  }
  if (
    shipment.sailedOnBoardDate !== null &&
    shipment.sailedOnBoardDate <= today
  ) {
    return "in_transit";
  }
  return "booked";
}
