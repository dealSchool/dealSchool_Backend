import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { getCohortSettings, setCohortStartDate, setCohortFee } from "@/lib/cohort-settings";
import { logInfo, logWarn } from "@/lib/logger";

export const runtime = "nodejs";

function serializeCohort(startDate: Date, feePaise: number) {
  return {
    startDate,
    feePaise,
    feeInRupees: feePaise / 100,
    feeDisplay:  `₹${(feePaise / 100).toFixed(0)}`,
  };
}

// ─── GET /api/settings/cohort — admin: read cohort start date + fee ───────────
export async function GET(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  const { startDate, feePaise } = await getCohortSettings();
  const s = serializeCohort(startDate, feePaise);
  return NextResponse.json(
    { startDate: s.startDate.toISOString(), feePaise: s.feePaise, feeInRupees: s.feeInRupees, feeDisplay: s.feeDisplay },
    { headers },
  );
}

// ─── PATCH /api/settings/cohort — admin: set cohort start date and/or fee ─────
// Both are optional per-call — send only what you want to change. The start
// date drives cancellation refund tiers (see src/lib/refund-service.ts); the
// fee is charged on every NEW payment link created after this call (existing
// links keep the amount they were created with).
export async function PATCH(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  const hasStartDate = typeof body.startDate === "string" && body.startDate.trim() !== "";
  const hasFee       = typeof body.feeInRupees === "number" && Number.isFinite(body.feeInRupees);

  if (!hasStartDate && !hasFee) {
    return NextResponse.json(
      { error: "Provide at least one of: startDate (e.g. \"2026-08-01\"), feeInRupees (e.g. 1000)" },
      { status: 400, headers },
    );
  }

  try {
    if (hasStartDate) await setCohortStartDate(body.startDate.trim());
    if (hasFee) await setCohortFee(body.feeInRupees);
  } catch {
    logWarn("api/settings/cohort", "Invalid startDate/feeInRupees rejected", { startDate: body.startDate, feeInRupees: body.feeInRupees });
    return NextResponse.json({ error: "Invalid startDate or feeInRupees" }, { status: 400, headers });
  }

  const { startDate, feePaise } = await getCohortSettings();
  const s = serializeCohort(startDate, feePaise);
  logInfo("api/settings/cohort", "Cohort settings updated", { startDate: s.startDate.toISOString(), feePaise: String(s.feePaise) });

  return NextResponse.json(
    { success: true, startDate: s.startDate.toISOString(), feePaise: s.feePaise, feeInRupees: s.feeInRupees, feeDisplay: s.feeDisplay },
    { headers },
  );
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
