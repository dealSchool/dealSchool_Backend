import { NextRequest, NextResponse } from "next/server";
import { logWarn, logError } from "@/lib/logger";
import { runBrochureReminder, type ReminderStage } from "@/lib/brochure-reminders";

export const runtime = "nodejs";

const STAGE_BY_SLUG: Record<string, ReminderStage> = { "1h": 1, "24h": 2, "36h": 3 };

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

// ─── GET /cron/brochure-reminders/[1h|24h|36h] — triggered by an external
// cron (OS crontab on the VPS), not by the frontend. Sends the matching
// WhatsApp reminder template to brochureRequests that crossed that stage's
// age threshold and haven't had it sent yet. ───────────────────────────────
export async function GET(request: NextRequest, { params }: { params: Promise<{ stage: string }> }) {
  if (!isAuthorized(request)) {
    logWarn("cron/brochure-reminders", "Unauthorized cron trigger attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { stage: stageSlug } = await params;
  const stage = STAGE_BY_SLUG[stageSlug];
  if (!stage) {
    return NextResponse.json({ error: `Unknown stage "${stageSlug}"` }, { status: 400 });
  }
  const { searchParams } = new URL(request.url);
  const force  = searchParams.get("force") === "true";
  const testId = searchParams.get("testId") ?? undefined;

  try {
    const result = await runBrochureReminder(stage, { force, testId });
    return NextResponse.json(result);
  } catch (err) {
    logError("cron/brochure-reminders", `Run failed stage=${stageSlug}`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
