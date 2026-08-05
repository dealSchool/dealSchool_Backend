import { NextRequest, NextResponse } from "next/server";
import { logWarn, logError } from "@/lib/logger";
import { runApplicationAuditReminder } from "@/lib/application-audit-reminder";

export const runtime = "nodejs";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

// ─── GET /cron/application-audit-followup — triggered by an external cron
// (OS crontab on the VPS) once daily. Sends the "application_under_audit"
// WhatsApp template to applications that have been in "under_review" for
// 48h+ and haven't been messaged yet for this audit period. ───────────────
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    logWarn("cron/application-audit-followup", "Unauthorized cron trigger attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const force  = searchParams.get("force") === "true";
  const testId = searchParams.get("testId") ?? undefined;

  try {
    const result = await runApplicationAuditReminder({ force, testId });
    return NextResponse.json(result);
  } catch (err) {
    logError("cron/application-audit-followup", "Run failed", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
