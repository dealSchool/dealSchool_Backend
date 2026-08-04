import { NextRequest, NextResponse } from "next/server";
import { logWarn, logError } from "@/lib/logger";
import { runIncompleteApplicantReminder, type ReminderStage } from "@/lib/incomplete-applicant-reminders";

export const runtime = "nodejs";

const STAGE_BY_SLUG: Record<string, ReminderStage> = { "1h": 1, "12h": 2, "24h": 3 };

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

// ─── GET /cron/incomplete-applicants/[1h|12h|24h] — triggered by an external
// cron (OS crontab on the VPS), not by the frontend. Sends the matching
// WhatsApp reminder template to applicationDrafts that crossed that stage's
// age threshold and haven't had it sent yet. ───────────────────────────────
export async function GET(request: NextRequest, { params }: { params: Promise<{ stage: string }> }) {
  if (!isAuthorized(request)) {
    logWarn("cron/incomplete-applicants", "Unauthorized cron trigger attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { stage: stageSlug } = await params;
  const stage = STAGE_BY_SLUG[stageSlug];
  if (!stage) {
    return NextResponse.json({ error: `Unknown stage "${stageSlug}"` }, { status: 400 });
  }

  try {
    const result = await runIncompleteApplicantReminder(stage);
    return NextResponse.json(result);
  } catch (err) {
    logError("cron/incomplete-applicants", `Run failed stage=${stageSlug}`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
