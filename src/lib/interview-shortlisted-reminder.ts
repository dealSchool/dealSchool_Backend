import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { sendWhatsAppTemplate, toWhatsAppId } from "@/lib/cheerio-whatsapp";
import { sendCheerioEmailTemplate } from "@/lib/cheerio-email-templates";
import { resolveCronDocs, FORCE_BYPASS_THRESHOLD } from "@/lib/cron-test-scope";

const REMINDER_HOURS = 48; // 2 days after status changes to "interview_invited"
const TEMPLATE_NAME = "interview_shortlisted_new";
const EMAIL_TEMPLATE_NAME = "interview_shortlisted";

// Static company scheduling link — configure the real one before deploying.
const SCHEDULE_URL = process.env.INTERVIEW_SCHEDULE_URL || "https://dealschool.in/schedule-interview";

function bodyParams(fullName: string): string[] {
  return [
    fullName,
    "once again on being shortlisted for the interview stage!",
    "booked your interview",
    "we'll see you soon. If not, don't forget to schedule your slot using the link shared with you on email.",
    "interview",
    "just reply here. We are here to help.",
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

export interface InterviewShortlistedRunResult {
  matched: number;
  sent: number;
  failed: number;
  skippedNoPhone: number;
  emailSent: number;
  emailFailed: number;
  skippedNoEmail: number;
}

// Called by the cron-triggered route at /cron/interview-shortlisted-followup —
// runs once daily. Query is (status, interviewReminderSent, statusChangedAt<=
// threshold) rather than a tight time window — a late or missed cron run
// still picks up every application that crossed the 48h-in-interview_invited
// mark and hasn't been messaged yet. Re-entering "interview_invited" resets
// interviewReminderSent (see PATCH /applications/[id]), so the timer restarts.
export async function runInterviewShortlistedReminder(
  opts: { force?: boolean; testId?: string } = {}
): Promise<InterviewShortlistedRunResult> {
  // force=true (local/manual testing only) bypasses the age threshold — pair
  // it with testId so it only ever touches that one document (see cron-test-scope.ts).
  const threshold = opts.force ? FORCE_BYPASS_THRESHOLD : new Date(Date.now() - REMINDER_HOURS * 60 * 60 * 1000);

  const collectionRef = adminDb.collection("applications");
  const query = collectionRef
    .where("status", "==", "interview_invited")
    .where("interviewReminderSent", "==", false)
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
  let emailSent = 0;
  let emailFailed = 0;
  let skippedNoEmail = 0;

  await runWithConcurrency(docs, CONCURRENCY, async (doc) => {
    const data = doc.data();
    const fullName     = data.fullName || "there";
    const mobileNumber = data.mobileNumber;
    const email        = data.email;

    if (!mobileNumber) {
      skippedNoPhone += 1;
      logWarn("interview-shortlisted-reminder", "Application has no mobileNumber, skipping", { applicationId: doc.id });
      return;
    }

    try {
      await sendWhatsAppTemplate({
        to: toWhatsAppId(String(mobileNumber)),
        templateName: TEMPLATE_NAME,
        bodyParams: bodyParams(String(fullName)),
        buttonUrl: SCHEDULE_URL,
      });
      await doc.ref.update({ interviewReminderSent: true, interviewReminderSentAt: FieldValue.serverTimestamp() });
      sent += 1;
    } catch (err) {
      failed += 1;
      logError("interview-shortlisted-reminder", `Reminder failed applicationId=${doc.id}`, err);
    }

    // Email tracks its own interviewReminderEmailSent flag independent of
    // interviewReminderSent above — see application-followup-reminder.ts for
    // why a stuck WhatsApp send would otherwise refire this email every tick.
    if (!email || data.interviewReminderEmailSent === true) {
      if (!email) skippedNoEmail += 1;
      return;
    }
    try {
      await sendCheerioEmailTemplate(EMAIL_TEMPLATE_NAME, String(email));
      await doc.ref.update({ interviewReminderEmailSent: true, interviewReminderEmailSentAt: FieldValue.serverTimestamp() });
      emailSent += 1;
    } catch (err) {
      emailFailed += 1;
      logError("interview-shortlisted-reminder", `Email reminder failed applicationId=${doc.id}`, err);
    }
  });

  const result: InterviewShortlistedRunResult = { matched: docs.length, sent, failed, skippedNoPhone, emailSent, emailFailed, skippedNoEmail };
  logInfo("interview-shortlisted-reminder", "Run complete", result as unknown as Record<string, unknown>);
  return result;
}
