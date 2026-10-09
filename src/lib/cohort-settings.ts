import { FieldValue, Filter, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

// Multi-cohort model:
//   cohorts/{n}      — one doc per cohort (name, startDate, feePaise, seats)
//   settings/cohort  — singleton pointing at the ACTIVE cohort (`activeCohort`).
//                      Its legacy `startDate` / `feePaise` fields (written by the
//                      old single-cohort PATCH /settings/cohort) are still read as
//                      Cohort 1's values until cohorts/1 carries its own.
//
// Every applicant-facing record (applications, applicationDrafts, contacts,
// brochureRequests, payments) is stamped server-side with `cohort: <number>` =
// the active cohort at creation time. Records created before cohorts existed
// have no `cohort` field and are treated as Cohort 1 everywhere (cohortOf()).
export const DEFAULT_COHORT_START_DATE = "2026-08-01";
const DEFAULT_FEE_PAISE = parseInt(process.env.FELLOWSHIP_FEE || "1000", 10) * 100;
const LEGACY_COHORT_SEATS = 20;
export const LEGACY_COHORT = 1;

const SETTINGS_DOC = adminDb.collection("settings").doc("cohort");
const COHORTS      = adminDb.collection("cohorts");

export interface Cohort {
  number:    number;
  name:      string;
  startDate: Date;
  feePaise:  number;
  seats:     number | null;
}

// Kept for existing callers — the active cohort's start date + fee (plus the
// extra identity fields).
export type CohortSettings = Cohort;

// Read from several hot paths (fee calc on every application/payment, cancel
// flow, every create endpoint's cohort stamp) but changes only via an explicit
// admin action, so it's cached in memory for a short TTL — same pattern as
// verify-admin.ts's admin-doc cache, which works here because this runs as a
// persistent Node process, not serverless. Invalidated on every write.
const CACHE_TTL_MS = 60 * 1000;
let settingsCache: { data: FirebaseFirestore.DocumentData | undefined; expiresAt: number } | null = null;
const cohortCache = new Map<number, { cohort: Cohort; expiresAt: number }>();

function invalidateCohortCache() {
  settingsCache = null;
  cohortCache.clear();
}

async function readSettingsDoc(): Promise<FirebaseFirestore.DocumentData | undefined> {
  if (settingsCache && Date.now() < settingsCache.expiresAt) return settingsCache.data;
  const snap = await SETTINGS_DOC.get();
  const data = snap.exists ? snap.data() : undefined;
  settingsCache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

function isCohortNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

// A record's cohort — records from before cohorts existed have no field and
// belong to Cohort 1.
export function cohortOf(data: { cohort?: unknown } | undefined | null): number {
  return isCohortNumber(data?.cohort) ? data!.cohort as number : LEGACY_COHORT;
}

export async function getActiveCohortNumber(): Promise<number> {
  const data = await readSettingsDoc();
  return isCohortNumber(data?.activeCohort) ? data!.activeCohort : LEGACY_COHORT;
}

export async function getCohort(number: number): Promise<Cohort> {
  const hit = cohortCache.get(number);
  if (hit && Date.now() < hit.expiresAt) return hit.cohort;

  const [snap, settings] = await Promise.all([
    COHORTS.doc(String(number)).get(),
    number === LEGACY_COHORT ? readSettingsDoc() : Promise.resolve(undefined),
  ]);
  const data = snap.exists ? snap.data() : undefined;

  const rawStart = data?.startDate instanceof Timestamp ? data.startDate : settings?.startDate;
  const startDate = rawStart instanceof Timestamp
    ? rawStart.toDate()
    : new Date(`${DEFAULT_COHORT_START_DATE}T00:00:00`);

  const feeOf = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
  const feePaise = feeOf(data?.feePaise) ?? feeOf(settings?.feePaise) ?? DEFAULT_FEE_PAISE;

  const seats = typeof data?.seats === "number" && data.seats > 0
    ? data.seats
    : number === LEGACY_COHORT ? LEGACY_COHORT_SEATS : null;

  const name = typeof data?.name === "string" && data.name.trim() ? data.name.trim() : `Cohort ${number}`;

  const cohort: Cohort = { number, name, startDate, feePaise, seats };
  cohortCache.set(number, { cohort, expiresAt: Date.now() + CACHE_TTL_MS });
  return cohort;
}

export async function getActiveCohort(): Promise<Cohort> {
  return getCohort(await getActiveCohortNumber());
}

// Existing callers (fee calc, GET /settings/cohort) — now resolves to the
// active cohort. Callers that act on an existing record should use
// getCohort(cohortOf(record)) instead so a Cohort 1 record isn't priced or
// refunded against Cohort 2's terms.
export async function getCohortSettings(): Promise<CohortSettings> {
  return getActiveCohort();
}

// Every cohort that exists (explicit docs + Cohort 1 + the active one), oldest first.
export async function listCohorts(): Promise<{ cohorts: Cohort[]; activeCohort: number }> {
  const [snap, activeCohort] = await Promise.all([COHORTS.get(), getActiveCohortNumber()]);
  const numbers = new Set<number>([LEGACY_COHORT, activeCohort]);
  for (const d of snap.docs) {
    const n = parseInt(d.id, 10);
    if (isCohortNumber(n)) numbers.add(n);
  }
  const cohorts = await Promise.all([...numbers].sort((a, b) => a - b).map(getCohort));
  return { cohorts, activeCohort };
}

function parseDate(dateStr: string): Date {
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  return date;
}

function parseFee(feeInRupees: number): number {
  if (!Number.isFinite(feeInRupees) || feeInRupees <= 0) throw new Error("Invalid fee");
  return Math.round(feeInRupees * 100);
}

export async function setCohortStartDate(dateStr: string, cohortNumber?: number): Promise<Date> {
  const date = parseDate(dateStr);
  const n = cohortNumber ?? await getActiveCohortNumber();
  await COHORTS.doc(String(n)).set(
    { number: n, startDate: Timestamp.fromDate(date), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  invalidateCohortCache();
  return date;
}

export async function setCohortFee(feeInRupees: number, cohortNumber?: number): Promise<number> {
  const feePaise = parseFee(feeInRupees);
  const n = cohortNumber ?? await getActiveCohortNumber();
  await COHORTS.doc(String(n)).set(
    { number: n, feePaise, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  invalidateCohortCache();
  return feePaise;
}

export class CohortNotFoundError extends Error {}

// Switch which cohort new applications/drafts/messages/brochure requests are
// stamped with. Existing records are never touched.
export async function setActiveCohort(number: number): Promise<void> {
  if (!isCohortNumber(number)) throw new Error("Invalid cohort number");
  if (number !== LEGACY_COHORT) {
    const snap = await COHORTS.doc(String(number)).get();
    if (!snap.exists) throw new CohortNotFoundError(`Cohort ${number} does not exist`);
  }
  await SETTINGS_DOC.set({ activeCohort: number, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  invalidateCohortCache();
}

// Creates the next cohort (highest existing number + 1) and makes it active in
// one transaction — from this moment every new record is stamped with it.
export async function startNewCohort(input: {
  startDate: string;
  feeInRupees: number;
  name?: string;
  seats?: number;
}): Promise<Cohort> {
  const startDate = parseDate(input.startDate);
  const feePaise  = parseFee(input.feeInRupees);
  if (input.seats !== undefined && !(Number.isInteger(input.seats) && input.seats > 0)) {
    throw new Error("Invalid seats");
  }

  const number = await adminDb.runTransaction(async (t) => {
    const [settingsSnap, latestSnap] = await Promise.all([
      t.get(SETTINGS_DOC),
      t.get(COHORTS.orderBy("number", "desc").limit(1)),
    ]);
    const active = isCohortNumber(settingsSnap.data()?.activeCohort) ? settingsSnap.data()!.activeCohort as number : LEGACY_COHORT;
    const latest = latestSnap.empty ? 0 : Number(latestSnap.docs[0].data().number) || 0;
    const next   = Math.max(active, latest, LEGACY_COHORT) + 1;

    t.set(COHORTS.doc(String(next)), {
      number:    next,
      name:      input.name?.trim() || `Cohort ${next}`,
      startDate: Timestamp.fromDate(startDate),
      feePaise,
      ...(input.seats !== undefined && { seats: input.seats }),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    t.set(SETTINGS_DOC, { activeCohort: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return next;
  });

  invalidateCohortCache();
  return getCohort(number);
}

// ─── Query helpers shared by the list/export/duplicate-check code ─────────────

// Parses the dashboard's ?cohort= filter. Missing / empty / "all" = no filter.
export function parseCohortFilter(raw: string | null): { cohort: number | null; invalid: boolean } {
  if (raw === null || raw.trim() === "" || raw.trim().toLowerCase() === "all") return { cohort: null, invalid: false };
  const n = Number(raw);
  return isCohortNumber(n) ? { cohort: n, invalid: false } : { cohort: null, invalid: true };
}

// Cache key for the first-page list caches — the page size alone is no longer
// enough since each cohort filter has its own result + counts.
export function listCacheKey(limit: number, cohort: number | null): string {
  return `${limit}:${cohort ?? "all"}`;
}

// Whether a matching application already exists in `cohort`. Matches are
// filtered in memory (not with where("cohort", "==", …)) so applications from
// before cohorts existed — which have no `cohort` field — still count as
// Cohort 1 and keep blocking duplicate Cohort 1 applications.
export async function applicationExistsInCohort(filter: Filter, cohort: number): Promise<boolean> {
  const snap = await adminDb.collection("applications").where(filter).limit(20).get();
  return snap.docs.some((d) => cohortOf(d.data()) === cohort);
}
