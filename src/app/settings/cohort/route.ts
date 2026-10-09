import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import {
  CohortNotFoundError,
  getActiveCohort,
  getActiveCohortNumber,
  getCohort,
  setActiveCohort,
  setCohortStartDate,
  setCohortFee,
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
  const requested = raw === null ? activeCohort : Number(raw);
  if (!Number.isInteger(requested) || requested < 1) {
    return NextResponse.json({ error: "cohort must be a positive integer" }, { status: 400, headers });
  }

  const cohort = requested === activeCohort ? await getActiveCohort() : await getCohort(requested);
  return NextResponse.json(serializeCohort(cohort, activeCohort), { headers });
}

// ─── PATCH /settings/cohort — admin: edit a cohort's start date / fee ─────────
// Body (all optional, send only what you want to change):
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

  const hasStartDate    = typeof body.startDate === "string" && body.startDate.trim() !== "";
  const hasFee          = typeof body.feeInRupees === "number" && Number.isFinite(body.feeInRupees);
  const hasActiveSwitch = body.activeCohort !== undefined;

  if (!hasStartDate && !hasFee && !hasActiveSwitch) {
    return NextResponse.json(
      { error: "Provide at least one of: startDate (e.g. \"2026-08-01\"), feeInRupees (e.g. 1000), activeCohort (e.g. 2)" },
      { status: 400, headers },
    );
  }

  try {
    if (hasActiveSwitch) {
      await setActiveCohort(Number(body.activeCohort));
    }

    const target = body.cohort !== undefined ? Number(body.cohort) : await getActiveCohortNumber();
    if (!Number.isInteger(target) || target < 1) {
      return NextResponse.json({ error: "cohort must be a positive integer" }, { status: 400, headers });
    }

    if (hasStartDate) await setCohortStartDate(body.startDate.trim(), target);
    if (hasFee) await setCohortFee(body.feeInRupees, target);
  } catch (err) {
    if (err instanceof CohortNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404, headers });
    }
    logWarn("api/settings/cohort", "Invalid cohort settings rejected", { startDate: body.startDate, feeInRupees: body.feeInRupees, activeCohort: body.activeCohort });
    return NextResponse.json({ error: "Invalid startDate, feeInRupees or cohort" }, { status: 400, headers });
  }

  const activeCohort = await getActiveCohortNumber();
  const cohort = await getCohort(body.cohort !== undefined ? Number(body.cohort) : activeCohort);
  const s = serializeCohort(cohort, activeCohort);
  logInfo("api/settings/cohort", "Cohort settings updated", { cohort: String(s.cohort), startDate: s.startDate, feePaise: String(s.feePaise), activeCohort: String(activeCohort) });

  return NextResponse.json({ success: true, ...s }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
