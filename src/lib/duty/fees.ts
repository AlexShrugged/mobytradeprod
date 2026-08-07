// Statutory nominal fee rates. MPF/HMF are ingested facts on entries, never
// computed downstream; these rates exist for *fabricated declared values*
// (seed, stub processor) and *estimated* landed cost, which applies them
// uncapped with an explicit caveat (CBP per-entry minimums/caps are
// unknowable per part). They live in duty/ — not seed-data — because
// production estimate code depends on them.
export const MPF_RATE = 0.003464;
export const HMF_RATE = 0.00125;
