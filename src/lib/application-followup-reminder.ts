import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { sendWhatsAppTemplate, toWhatsAppId } from "@/lib/cheerio-whatsapp";
import { sendCheerioEmailTemplate } from "@/lib/cheerio-email-templates";
import { resolveCronDocs, FORCE_BYPASS_THRESHOLD } from "@/lib/cron-test-scope";

const FOLLOWUP_HOURS = 48; // 2 days after full application submission
const TEMPLATE_NAME = "application_submitted_followup";
const EMAIL_TEMPLATE_NAME = "application_submitted_followup";

function bodyParams(fullName: string): string[] {
  return [
    fullName,
    "application for the DealSchool Venture Capital Fellowship.",
    "reviewing it, and we'll keep you updated as your application progresses.",
    "Thanks for applying! We will share the next steps with you soon.",
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

// Only meaningful while the applicant is still waiting on a first decision —
// "we're reviewing it, we'll share next steps soon" reads as a mistake to
// someone already interview_invited/accepted/declined/cancelled within the
// same 48h window. Filtered in memory (not added to the Firestore query)
// specifically to avoid requiring a new composite index right before this
// goes live — the query stays on its existing (followupSent, createdAt) index.
const ELIGIBLE_STATUSES = new Set(["pending", "under_review"]);

export interface FollowupRunResult {
  matched: number;
  sent: number;
  failed: number;
  skippedNoPhone: number;
  skippedStatusMoved: number;
  emailSent: number;
  emailFailed: number;
  skippedNoEmail: number;
}

// Called by the cron-triggered route at /cron/application-followup — runs
// once daily. Query is (followupSent, createdAt<=threshold) rather than a
// tight time window — a late or missed cron run still picks up every
// application that has crossed the 48h mark and hasn't been messaged yet.
export async function runApplicationFollowupReminder(
  opts: { force?: boolean; testId?: string } = {}
): Promise<FollowupRunResult> {
  // force=true (local/manual testing only) bypasses the age threshold — pair
  // it with testId so it only ever touches that one document (see cron-test-scope.ts).
  const threshold = opts.force ? FORCE_BYPASS_THRESHOLD : new Date(Date.now() - FOLLOWUP_HOURS * 60 * 60 * 1000);

  const collectionRef = adminDb.collection("applications");
  const query = collectionRef
    .where("followupSent", "==", false)
    .where("createdAt", "<=", threshold)
    // Explicit oldest-first order — see incomplete-applicant-reminders.ts for
    // why this matters once a backlog can exceed BATCH_CAP. Same existing
    // composite index, no new index needed.
    .orderBy("createdAt", "asc")
    .limit(BATCH_CAP);
  const docs = await resolveCronDocs(collectionRef, query, opts.testId);

  let sent = 0;
  let failed = 0;
  let skippedNoPhone = 0;
  let skippedStatusMoved = 0;
  let emailSent = 0;
  let emailFailed = 0;
  let skippedNoEmail = 0;

  await runWithConcurrency(docs, CONCURRENCY, async (doc) => {
    const data = doc.data();
    const fullName     = data.fullName || "there";
    const mobileNumber = data.mobileNumber;
    const email        = data.email;

    if (!ELIGIBLE_STATUSES.has(String(data.status))) {
      skippedStatusMoved += 1;
      // Mark handled rather than leaving followupSent=false — otherwise this
      // application matches every future run's query forever with no way to
      // ever stop re-evaluating it.
      await doc.ref.update({ followupSent: true, followupSentAt: FieldValue.serverTimestamp() });
      logInfo("application-followup-reminder", "Status has already moved past pending review, skipping", { applicationId: doc.id, status: data.status });
      return;
    }

    if (!mobileNumber) {
      skippedNoPhone += 1;
      logWarn("application-followup-reminder", "Application has no mobileNumber, skipping", { applicationId: doc.id });
      return;
    }

    try {
      await sendWhatsAppTemplate({
        to: toWhatsAppId(String(mobileNumber)),
        templateName: TEMPLATE_NAME,
        bodyParams: bodyParams(String(fullName)),
      });
      await doc.ref.update({ followupSent: true, followupSentAt: FieldValue.serverTimestamp() });
      sent += 1;
    } catch (err) {
      failed += 1;
      logError("application-followup-reminder", `Reminder failed applicationId=${doc.id}`, err);
    }

    // Email tracks its own followupEmailSent flag independent of followupSent
    // above — a stuck WhatsApp send leaves followupSent=false forever, which
    // would otherwise refire this email on every single cron tick instead of
    // once.
    if (!email || data.followupEmailSent === true) {
      if (!email) skippedNoEmail += 1;
      return;
    }
    try {
      await sendCheerioEmailTemplate(EMAIL_TEMPLATE_NAME, String(email));
      await doc.ref.update({ followupEmailSent: true, followupEmailSentAt: FieldValue.serverTimestamp() });
      emailSent += 1;
    } catch (err) {
      emailFailed += 1;
      logError("application-followup-reminder", `Email reminder failed applicationId=${doc.id}`, err);
    }
  });

  const result: FollowupRunResult = { matched: docs.length, sent, failed, skippedNoPhone, skippedStatusMoved, emailSent, emailFailed, skippedNoEmail };
  logInfo("application-followup-reminder", "Run complete", result as unknown as Record<string, unknown>);
  return result;
}
