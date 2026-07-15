import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { getPaymentMode, setPaymentMode } from "@/lib/payment-mode-settings";
import { logInfo, logWarn } from "@/lib/logger";

export const runtime = "nodejs";

// ─── GET /settings/payment — admin: read active Cashfree mode ────────────────
export async function GET(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  const mode = await getPaymentMode();
  return NextResponse.json({ mode }, { headers });
}

// ─── PATCH /settings/payment — admin: switch between sandbox and live ────────
// Applies to every NEW Cashfree API call (payment links, refunds, webhook
// signature verification) made after this call — payment links already sent
// under the previous mode are unaffected.
export async function PATCH(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  if (body.mode !== "sandbox" && body.mode !== "live") {
    logWarn("api/settings/payment", "Invalid mode rejected", { mode: body.mode });
    return NextResponse.json({ error: 'mode must be "sandbox" or "live"' }, { status: 400, headers });
  }

  const mode = await setPaymentMode(body.mode);
  logInfo("api/settings/payment", "Payment mode updated", { mode });

  return NextResponse.json({ success: true, mode }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
