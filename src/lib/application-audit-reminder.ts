import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { sendWhatsAppTemplate, toWhatsAppId } from "@/lib/cheerio-whatsapp";
import { resolveCronDocs, FORCE_BYPASS_THRESHOLD } from "@/lib/cron-test-scope";

const AUDIT_FOLLOWUP_HOURS = 48; // 2 days after entering "under_review" (audit)
const TEMPLATE_NAME = "application_under_audit";

function bodyParams(fullName: string): string[] {
  return [
    fullName,
    "application",
    "our admissions team",
    "We're taking the time to carefully evaluate every application, and we'll reach out as soon as the review is complete.",
  ];
}

// Per-run cap so a job that hasn't run in a while (deploy downtime, crontab
// misfire) doesn't suddenly fire hundreds of messages in one burst.
const BATCH_CAP = 200;
// How many Cheerio calls run at once — stay gentle on their rate limits.
const CONCURRENCY = 5;

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

export interface AuditFollowupRunResult {
  matched: number;
  sent: number;
  failed: number;
  skippedNoPhone: number;
}

// Called by the cron-triggered route at /cron/application-audit-followup —
// runs once daily. Query is (status, auditFollowupSent, statusChangedAt<=
// threshold) rather than a tight time window — a late or missed cron run
// still picks up every application that crossed the 48h-in-audit mark and
// hasn't been messaged yet. Re-entering "under_review" after leaving it
// resets auditFollowupSent (see PATCH /applications/[id]), so the timer
// restarts correctly.
export async function runApplicationAuditReminder(
  opts: { force?: boolean; testId?: string } = {}
): Promise<AuditFollowupRunResult> {
  // force=true (local/manual testing only) bypasses the age threshold — pair
  // it with testId so it only ever touches that one document (see cron-test-scope.ts).
  const threshold = opts.force ? FORCE_BYPASS_THRESHOLD : new Date(Date.now() - AUDIT_FOLLOWUP_HOURS * 60 * 60 * 1000);

  const collectionRef = adminDb.collection("applications");
  const query = collectionRef
    .where("status", "==", "under_review")
    .where("auditFollowupSent", "==", false)
    .where("statusChangedAt", "<=", threshold)
    // Explicit oldest-first order — see incomplete-applicant-reminders.ts for
    // why this matters once a backlog can exceed BATCH_CAP. Same existing
    // composite index, no new index needed.
    .orderBy("statusChangedAt", "asc")
    .limit(BATCH_CAP);
  const docs = await resolveCronDocs(collectionRef, query, opts.testId);

  let sent = 0;
  let failed = 0;
  let skippedNoPhone = 0;

  await runWithConcurrency(docs, CONCURRENCY, async (doc) => {
    const data = doc.data();
    const fullName     = data.fullName || "there";
    const mobileNumber = data.mobileNumber;

    if (!mobileNumber) {
      skippedNoPhone += 1;
      logWarn("application-audit-reminder", "Application has no mobileNumber, skipping", { applicationId: doc.id });
      return;
    }

    try {
      await sendWhatsAppTemplate({
        to: toWhatsAppId(String(mobileNumber)),
        templateName: TEMPLATE_NAME,
        bodyParams: bodyParams(String(fullName)),
      });
      await doc.ref.update({ auditFollowupSent: true, auditFollowupSentAt: FieldValue.serverTimestamp() });
      sent += 1;
    } catch (err) {
      failed += 1;
      logError("application-audit-reminder", `Reminder failed applicationId=${doc.id}`, err);
    }
  });

  const result: AuditFollowupRunResult = { matched: docs.length, sent, failed, skippedNoPhone };
  logInfo("application-audit-reminder", "Run complete", result as unknown as Record<string, unknown>);
  return result;
}
