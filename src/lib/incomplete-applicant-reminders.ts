import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { sendWhatsAppTemplate, toWhatsAppId } from "@/lib/cheerio-whatsapp";
import { sendCheerioEmailTemplate } from "@/lib/cheerio-email-templates";
import { resolveCronDocs, FORCE_BYPASS_THRESHOLD } from "@/lib/cron-test-scope";
import { getActiveCohort, type Cohort } from "@/lib/cohort-settings";

export type ReminderStage = 1 | 2 | 3;

const APPLY_URL = "https://dealschool.in/applynow";

// Hours since draft creation (createdAt, not last-edit) before each stage fires.
const STAGE_HOURS: Record<ReminderStage, number> = { 1: 1, 2: 24, 3: 36 };

// emailTemplate keys match the "Template Name" column in the DealSchool Email
// Templates sheet — kept separate from the WhatsApp `name` above since the
// Meta-approved WhatsApp template names carry their own versioned suffixes
// (e.g. "_final") that the email templates don't use.
// The apply link always leads to the currently active cohort's form, so the
// seat-scarcity copy names the active cohort rather than a hardcoded one.
const STAGE_TEMPLATES: Record<ReminderStage, { name: string; emailTemplate: string; body: (fullName: string, cohort: Cohort | null) => string[] }> = {
  1: {
    name: "incomplete_applications_1",
    emailTemplate: "incomplete_applications_1",
    body: (fullName, cohort) => [
      fullName,
      "you started your DealSchool application but didn't finish it.",
      !cohort ? "Seats are limited."
        : cohort.seats ? `${cohort.name} has only ${cohort.seats} seats.` : `${cohort.name} has limited seats.`,
      "application from where you left off",
    ],
  },
  2: {
    name: "incomplete_applications_2",
    emailTemplate: "incomplete_applications_2",
    body: (fullName, _cohort) => [
      fullName,
      "application",
      "If you had any questions or got stuck somewhere, just reply here — we'll help you through it.",
      "application from where you left off",
    ],
  },
  3: {
    name: "incomplete_applications_3_final",
    emailTemplate: "incomplete_applications_3",
    body: (fullName, cohort) => [
      fullName,
      "last one from us 🙏",
      cohort ? `${cohort.name} is filling up and your application is still pending.` : "Seats are filling up and your application is still pending.",
      "isn't the right fit",
      "But if you're still interested — this is the nudge.",
      "application from where you left off",
    ],
  },
};

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

export interface ReminderRunResult {
  stage: ReminderStage;
  matched: number;
  sent: number;
  failed: number;
  skippedNoPhone: number;
  emailSent: number;
  emailFailed: number;
  skippedNoEmail: number;
}

// Called by the cron-triggered routes at /cron/incomplete-applicants/[1h|24h|36h].
// Query is (status, prevStage, createdAt<=threshold) rather than a tight time
// window — a late or missed cron run still picks up every applicant who has
// crossed the threshold and hasn't had this stage's message sent yet.
export async function runIncompleteApplicantReminder(
  stage: ReminderStage,
  opts: { force?: boolean; testId?: string } = {}
): Promise<ReminderRunResult> {
  const prevStage = stage - 1;
  const template = STAGE_TEMPLATES[stage];
  // force=true (local/manual testing only) bypasses the age threshold — pair
  // it with testId so it only ever touches that one document (see cron-test-scope.ts).
  const threshold = opts.force ? FORCE_BYPASS_THRESHOLD : new Date(Date.now() - STAGE_HOURS[stage] * 60 * 60 * 1000);

  const collectionRef = adminDb.collection("applicationDrafts");
  const query = collectionRef
    .where("status", "==", "in_progress")
    .where("reminderStage", "==", prevStage)
    .where("createdAt", "<=", threshold)
    // Explicit oldest-first order — without this, Firestore doesn't
    // contractually guarantee which BATCH_CAP docs come back if a backlog
    // ever exceeds the cap. With it, a backlog drains oldest-overdue-first
    // across successive hourly ticks instead of risking the same/arbitrary
    // subset winning every time. Uses the same composite index already
    // required for the filters above — no new index needed.
    .orderBy("createdAt", "asc")
    .limit(BATCH_CAP);
  const docs = await resolveCronDocs(collectionRef, query, opts.testId);
  // A settings read hiccup must not stop every nudge — fall back to neutral wording.
  const activeCohort = await getActiveCohort().catch((err) => {
    logError("incomplete-applicant-reminders", "Could not load the active cohort — using generic wording", err);
    return null;
  });

  let sent = 0;
  let failed = 0;
  let skippedNoPhone = 0;
  let emailSent = 0;
  let emailFailed = 0;
  let skippedNoEmail = 0;

  await runWithConcurrency(docs, CONCURRENCY, async (doc) => {
    const data = doc.data();
    const fullName = data.formData?.fullName || "there";
    const mobileNumber = data.mobileNumber;
    const email = data.email;

    if (!mobileNumber) {
      skippedNoPhone += 1;
      logWarn("incomplete-applicant-reminders", "Draft has no mobileNumber, skipping", { draftId: doc.id, stage });
      return;
    }

    try {
      await sendWhatsAppTemplate({
        to: toWhatsAppId(String(mobileNumber)),
        templateName: template.name,
        bodyParams: template.body(String(fullName), activeCohort),
        buttonUrl: APPLY_URL,
      });
      await doc.ref.update({ reminderStage: stage, lastReminderSentAt: FieldValue.serverTimestamp() });
      sent += 1;
    } catch (err) {
      failed += 1;
      logError("incomplete-applicant-reminders", `Reminder failed draftId=${doc.id} stage=${stage}`, err);
    }

    // Email tracks its own progression (emailReminderStage) independent of
    // reminderStage above — the doc keeps matching this stage's query on
    // every run until the WhatsApp send succeeds (see the query's prevStage
    // filter), so without a separate gate a stuck WhatsApp send would refire
    // this stage's email on every single cron tick instead of once.
    const emailStageAlreadySent = Number(data.emailReminderStage ?? 0) >= stage;
    if (!email || emailStageAlreadySent) {
      if (!email) skippedNoEmail += 1;
      return;
    }
    try {
      await sendCheerioEmailTemplate(template.emailTemplate, String(email));
      await doc.ref.update({ emailReminderStage: stage, lastEmailReminderSentAt: FieldValue.serverTimestamp() });
      emailSent += 1;
    } catch (err) {
      emailFailed += 1;
      logError("incomplete-applicant-reminders", `Email reminder failed draftId=${doc.id} stage=${stage}`, err);
    }
  });

  const result: ReminderRunResult = { stage, matched: docs.length, sent, failed, skippedNoPhone, emailSent, emailFailed, skippedNoEmail };
  logInfo("incomplete-applicant-reminders", "Run complete", result as unknown as Record<string, unknown>);
  return result;
}
