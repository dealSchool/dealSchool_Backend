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
// The active-cohort pointer decides which cohort every new record is stamped
// with, so it gets a much shorter TTL — if the app ever runs as several
// processes, a stale copy would attach new applications to the previous cohort.
const ACTIVE_COHORT_TTL_MS = 10 * 1000;
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
  settingsCache = { data, expiresAt: Date.now() + ACTIVE_COHORT_TTL_MS };
  return data;
}

function isCohortNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

// Strict parser for a cohort number coming from a request (query string or JSON
// body): a positive whole number, or a string of plain digits. Rejects booleans,
// null, "1e3", "0x10", "1.5", "-1", "" … so nothing is silently coerced into a
// real cohort (e.g. Number(true) === 1).
export function parseCohortNumber(v: unknown): number | null {
  if (typeof v === "number") return isCohortNumber(v) && v <= 999_999_999 ? v : null;
  if (typeof v === "string" && /^[1-9]\d{0,8}$/.test(v.trim())) return Number(v.trim());
  return null;
}

// Admin-typed cohort names end up in emails and WhatsApp template parameters
// (which reject newlines/tabs), so strip control characters, collapse runs of
// whitespace and cap the length. Returns undefined when nothing usable is left.
export function sanitizeCohortName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return cleaned || undefined;
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

// "YYYY-MM-DD" of the start date in the SERVER's local calendar — the same
// calendar the date was entered in and that refund tiers are computed in.
// toISOString() converts to UTC, which shows the previous day on a server whose
// timezone is ahead of UTC (e.g. IST), so the admin UI uses this for editing.
export function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

// "YYYY-MM-DD" only, and it must be a real calendar day — JS would otherwise
// roll "2027-02-30" over to March 2.
function parseDate(dateStr: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  if (!m) throw new Error("Invalid date");
  const date = new Date(`${m[0]}T00:00:00`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== Number(m[1]) ||
    date.getMonth() + 1 !== Number(m[2]) ||
    date.getDate() !== Number(m[3])
  ) {
    throw new Error("Invalid date");
  }
  return date;
}

// A whole number of seats, 1 – 100000 (shared by "start cohort" and "edit seats").
export function isValidSeats(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100_000;
}

function parseFee(feeInRupees: number): number {
  if (!Number.isFinite(feeInRupees) || feeInRupees <= 0) throw new Error("Invalid fee");
  return Math.round(feeInRupees * 100);
}

export class CohortNotFoundError extends Error {}

// Cohort 1 always exists (legacy/default); every other cohort needs its doc.
export async function cohortExists(number: number): Promise<boolean> {
  if (number === LEGACY_COHORT) return true;
  return (await COHORTS.doc(String(number)).get()).exists;
}

export async function setCohortStartDate(dateStr: string, cohortNumber?: number): Promise<Date> {
  const date = parseDate(dateStr);
  const n = cohortNumber ?? await getActiveCohortNumber();
  if (!(await cohortExists(n))) throw new CohortNotFoundError(`Cohort ${n} does not exist`);
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
  if (!(await cohortExists(n))) throw new CohortNotFoundError(`Cohort ${n} does not exist`);
  await COHORTS.doc(String(n)).set(
    { number: n, feePaise, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  invalidateCohortCache();
  return feePaise;
}

// Seat count shown in reminder messages ("Cohort 2 has only 20 seats."). Editable
// at any time; it is display copy only and doesn't limit how many people can apply.
export async function setCohortSeats(seats: number, cohortNumber?: number): Promise<number> {
  if (!isValidSeats(seats)) throw new Error("Invalid seats");
  const n = cohortNumber ?? await getActiveCohortNumber();
  if (!(await cohortExists(n))) throw new CohortNotFoundError(`Cohort ${n} does not exist`);
  await COHORTS.doc(String(n)).set(
    { number: n, seats, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  invalidateCohortCache();
  return seats;
}

// Switch which cohort new applications/drafts/messages/brochure requests are
// stamped with. Existing records are never touched.
export async function setActiveCohort(number: number): Promise<void> {
  if (!isCohortNumber(number)) throw new Error("Invalid cohort number");
  if (!(await cohortExists(number))) throw new CohortNotFoundError(`Cohort ${number} does not exist`);
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
  if (input.seats !== undefined && !isValidSeats(input.seats)) {
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
      name:      sanitizeCohortName(input.name) ?? `Cohort ${next}`,
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
  const n = parseCohortNumber(raw);
  return n !== null ? { cohort: n, invalid: false } : { cohort: null, invalid: true };
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
