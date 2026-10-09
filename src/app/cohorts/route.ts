import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { listCohorts, startNewCohort, type Cohort } from "@/lib/cohort-settings";
import { logInfo, logWarn, logError } from "@/lib/logger";

export const runtime = "nodejs";

function serialize(c: Cohort, activeCohort: number) {
  return {
    cohort:      c.number,
    name:        c.name,
    isActive:    c.number === activeCohort,
    startDate:   c.startDate.toISOString(),
    seats:       c.seats,
    feeInRupees: c.feePaise / 100,
    feeDisplay:  `₹${(c.feePaise / 100).toFixed(0)}`,
  };
}

// ─── GET /cohorts — admin: every cohort + which one is active ─────────────────
// Feeds the dashboard's cohort filter dropdown.
export async function GET(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  try {
    const { cohorts, activeCohort } = await listCohorts();
    return NextResponse.json(
      { activeCohort, cohorts: cohorts.map((c) => serialize(c, activeCohort)) },
      { headers },
    );
  } catch (err) {
    logError("api/cohorts", "GET unhandled error", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers });
  }
}

// ─── POST /cohorts — admin: start the next cohort and make it active ──────────
// Body: { startDate: "2026-11-01", feeInRupees: 1000, name?: "Cohort 2", seats?: 20 }
// The new cohort gets the next number automatically. From this moment every new
// application / draft / contact message / brochure request is stamped with it;
// existing records keep the cohort they were created under.
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  if (typeof body.startDate !== "string" || !body.startDate.trim() || typeof body.feeInRupees !== "number") {
    return NextResponse.json(
      { error: "startDate (e.g. \"2026-11-01\") and feeInRupees (e.g. 1000) are required. Optional: name, seats." },
      { status: 400, headers },
    );
  }

  try {
    const cohort = await startNewCohort({
      startDate:   body.startDate.trim(),
      feeInRupees: body.feeInRupees,
      name:        typeof body.name === "string" ? body.name : undefined,
      seats:       typeof body.seats === "number" ? body.seats : undefined,
    });
    logInfo("api/cohorts", "New cohort started and activated", { cohort: String(cohort.number), name: cohort.name });
    return NextResponse.json({ success: true, ...serialize(cohort, cohort.number) }, { status: 201, headers });
  } catch (err: any) {
    if (err?.message === "Invalid date" || err?.message === "Invalid fee" || err?.message === "Invalid seats") {
      logWarn("api/cohorts", "Invalid new-cohort input rejected", { message: err.message });
      return NextResponse.json({ error: err.message }, { status: 400, headers });
    }
    logError("api/cohorts", "POST unhandled error", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers });
  }
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
