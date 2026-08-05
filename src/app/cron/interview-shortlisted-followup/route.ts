import { NextRequest, NextResponse } from "next/server";
import { logWarn, logError } from "@/lib/logger";
import { runInterviewShortlistedReminder } from "@/lib/interview-shortlisted-reminder";

export const runtime = "nodejs";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

// ─── GET /cron/interview-shortlisted-followup — triggered by an external cron
// (OS crontab on the VPS) once daily. Sends the "interview_shortlisted_new"
// WhatsApp template to applications that have been in "interview_invited" for
// 48h+ and haven't been messaged yet for this stage. ───────────────────────
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    logWarn("cron/interview-shortlisted-followup", "Unauthorized cron trigger attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const force  = searchParams.get("force") === "true";
  const testId = searchParams.get("testId") ?? undefined;

  try {
    const result = await runInterviewShortlistedReminder({ force, testId });
    return NextResponse.json(result);
  } catch (err) {
    logError("cron/interview-shortlisted-followup", "Run failed", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
