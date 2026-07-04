// Cancellation-by-the-Fellow refund policy:
//   5+ days before cohort start   -> 100% refund
//   1-4 days before cohort start  -> 50% refund
//   On/after cohort start         -> no refund
//
// The cohort start date itself lives in src/lib/cohort-settings.ts
// (admin-configurable via PATCH /api/settings/cohort).

export interface RefundTier {
  percent: number; // 100 | 50 | 0
  daysBeforeStart: number;
}

/**
 * Compares calendar days (not exact hours) so the tier a Fellow lands in
 * doesn't depend on what time of day they happen to request cancellation.
 */
export function computeRefundTier(programmeStartDate: Date, now: Date = new Date()): RefundTier {
  const startDay = Date.UTC(programmeStartDate.getFullYear(), programmeStartDate.getMonth(), programmeStartDate.getDate());
  const nowDay   = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const daysBeforeStart = Math.round((startDay - nowDay) / 86_400_000);

  let percent: number;
  if (daysBeforeStart >= 5) percent = 100;
  else if (daysBeforeStart >= 1) percent = 50;
  else percent = 0;

  return { percent, daysBeforeStart };
}
