import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

// Singleton doc — one active cohort (start date + fee) at a time, matching the
// rest of the codebase's single-cohort design. Falls back to env vars / hardcoded
// defaults until an admin explicitly sets values via PATCH /settings/cohort.
export const DEFAULT_COHORT_START_DATE = "2026-08-01";
const DEFAULT_FEE_PAISE = parseInt(process.env.FELLOWSHIP_FEE || "1000", 10) * 100;

const COHORT_DOC = adminDb.collection("settings").doc("cohort");

export interface CohortSettings {
  startDate: Date;
  feePaise:  number;
}

export async function getCohortSettings(): Promise<CohortSettings> {
  const snap = await COHORT_DOC.get();
  const data = snap.exists ? snap.data() : undefined;

  const startDate = data?.startDate instanceof Timestamp
    ? data.startDate.toDate()
    : new Date(`${DEFAULT_COHORT_START_DATE}T00:00:00`);

  const feePaise = typeof data?.feePaise === "number" && data.feePaise > 0
    ? data.feePaise
    : DEFAULT_FEE_PAISE;

  return { startDate, feePaise };
}

export async function setCohortStartDate(dateStr: string): Promise<Date> {
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date");
  }
  await COHORT_DOC.set(
    { startDate: Timestamp.fromDate(date), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return date;
}

export async function setCohortFee(feeInRupees: number): Promise<number> {
  if (!Number.isFinite(feeInRupees) || feeInRupees <= 0) {
    throw new Error("Invalid fee");
  }
  const feePaise = Math.round(feeInRupees * 100);
  await COHORT_DOC.set(
    { feePaise, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return feePaise;
}
