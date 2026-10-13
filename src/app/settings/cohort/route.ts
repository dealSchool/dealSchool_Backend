import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import {
  CohortNotFoundError,
  cohortExists,
  localDateString,
  getActiveCohort,
  getActiveCohortNumber,
  getCohort,
  isValidSeats,
  parseCohortNumber,
  setActiveCohort,
  setCohortStartDate,
  setCohortFee,
  setCohortSeats,
  type Cohort,
} from "@/lib/cohort-settings";
import { logInfo, logWarn } from "@/lib/logger";

export const runtime = "nodejs";

function serializeCohort(c: Cohort, activeCohort: number) {
  return {
    cohort:       c.number,
    name:         c.name,
    isActive:     c.number === activeCohort,
    activeCohort,
    startDate:    c.startDate.toISOString(),
    startDateLocal: localDateString(c.startDate),
    seats:        c.seats,
    feePaise:     c.feePaise,
    feeInRupees:  c.feePaise / 100,
    feeDisplay:   `₹${(c.feePaise / 100).toFixed(0)}`,
  };
}

// ─── GET /settings/cohort — admin: read the active cohort (or ?cohort=<n>) ────
export async function GET(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  const activeCohort = await getActiveCohortNumber();
  const raw = new URL(request.url).searchParams.get("cohort");
  const requested = raw === null ? activeCohort : parseCohortNumber(raw);
  if (requested === null) {
    return NextResponse.json({ error: "cohort must be a positive integer" }, { status: 400, headers });
  }
  if (requested !== activeCohort && !(await cohortExists(requested))) {
    return NextResponse.json({ error: `Cohort ${requested} does not exist` }, { status: 404, headers });
  }

  const cohort = requested === activeCohort ? await getActiveCohort() : await getCohort(requested);
  return NextResponse.json(serializeCohort(cohort, activeCohort), { headers });
}

// ─── PATCH /settings/cohort — admin: edit a cohort's start date / fee ─────────
// Body (all optional, send only what you want to change):
//   seats        — whole number, e.g. 20; shown in the reminder messages
//   startDate    — "2026-08-01"; drives cancellation refund tiers (see src/lib/refund-service.ts)
//   feeInRupees  — charged on every NEW payment link created after this call
//                  (existing links keep the amount they were created with)
//   cohort       — which cohort to edit; defaults to the active one
//   activeCohort — switch which existing cohort new applications are attached to
//                  (use POST /cohorts to create + activate a brand-new cohort)
export async function PATCH(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400, headers });
  }

  const hasStartDate    = typeof body.startDate === "string" && body.startDate.trim() !== "";
  const hasFee          = typeof body.feeInRupees === "number" && Number.isFinite(body.feeInRupees);
  const hasActiveSwitch = body.activeCohort !== undefined;
  const hasSeats        = body.seats !== undefined;

  if (!hasStartDate && !hasFee && !hasActiveSwitch && !hasSeats) {
    return NextResponse.json(
      { error: "Provide at least one of: startDate (e.g. \"2026-08-01\"), feeInRupees (e.g. 1000), seats (e.g. 20), activeCohort (e.g. 2)" },
      { status: 400, headers },
    );
  }
  // Validated up front so a bad seat count can't leave an earlier field half-saved.
  if (hasSeats && !isValidSeats(body.seats)) {
    return NextResponse.json({ error: "seats must be a whole number between 1 and 100000" }, { status: 400, headers });
  }

  // Strict parsing — never coerce junk (true, null, "1e3"…) into a real cohort number.
  const switchTo = hasActiveSwitch ? parseCohortNumber(body.activeCohort) : undefined;
  if (hasActiveSwitch && switchTo === null) {
    return NextResponse.json({ error: "activeCohort must be a positive integer" }, { status: 400, headers });
  }
  const explicitTarget = body.cohort !== undefined ? parseCohortNumber(body.cohort) : undefined;
  if (body.cohort !== undefined && explicitTarget === null) {
    return NextResponse.json({ error: "cohort must be a positive integer" }, { status: 400, headers });
  }

  try {
    if (switchTo != null) {
      await setActiveCohort(switchTo);
    }

    const target = explicitTarget ?? await getActiveCohortNumber();

    if (hasStartDate) await setCohortStartDate(body.startDate.trim(), target);
    if (hasFee) await setCohortFee(body.feeInRupees, target);
    if (hasSeats) await setCohortSeats(body.seats, target);
  } catch (err) {
    if (err instanceof CohortNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404, headers });
    }
    logWarn("api/settings/cohort", "Invalid cohort settings rejected", { startDate: body.startDate, feeInRupees: body.feeInRupees, seats: body.seats, activeCohort: body.activeCohort });
    return NextResponse.json({ error: "Invalid startDate, feeInRupees, seats or cohort" }, { status: 400, headers });
  }

  const activeCohort = await getActiveCohortNumber();
  const cohort = await getCohort(explicitTarget ?? activeCohort);
  const s = serializeCohort(cohort, activeCohort);
  logInfo("api/settings/cohort", "Cohort settings updated", { cohort: String(s.cohort), startDate: s.startDate, feePaise: String(s.feePaise), activeCohort: String(activeCohort) });

  return NextResponse.json({ success: true, ...s }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
