import { NextRequest, NextResponse } from "next/server";
import { logWarn, logError } from "@/lib/logger";
import { runPaymentReminder } from "@/lib/payment-reminder";

export const runtime = "nodejs";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

// ─── GET /cron/payment-reminder — triggered by an external cron (OS crontab
// on the VPS) once daily. Sends the "payment_reminder_new" WhatsApp template
// to accepted applications whose payment link was sent 24h+ ago and are
// still unpaid. ─────────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    logWarn("cron/payment-reminder", "Unauthorized cron trigger attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const force  = searchParams.get("force") === "true";
  const testId = searchParams.get("testId") ?? undefined;

  try {
    const result = await runPaymentReminder({ force, testId });
    return NextResponse.json(result);
  } catch (err) {
    logError("cron/payment-reminder", "Run failed", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
