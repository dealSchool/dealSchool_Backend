import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { sendWhatsAppTemplate, toWhatsAppId } from "@/lib/cheerio-whatsapp";
import { sendCheerioEmailTemplate } from "@/lib/cheerio-email-templates";
import { resolveCronDocs, FORCE_BYPASS_THRESHOLD } from "@/lib/cron-test-scope";

export type ReminderStage = 1 | 2 | 3;

const APPLY_URL = "https://dealschool.in/applynow";

// Hours since brochure request creation (createdAt) before each stage fires.
const STAGE_HOURS: Record<ReminderStage, number> = { 1: 1, 2: 24, 3: 36 };

// emailTemplate keys match the "Template Name" column in the DealSchool Email
// Templates sheet — see incomplete-applicant-reminders.ts for why this is
// separate from the Meta-approved WhatsApp `name` above.
const STAGE_TEMPLATES: Record<ReminderStage, { name: string; emailTemplate: string; body: (name: string) => string[] }> = {
  1: {
    name: "brochure_application_1_new",
    emailTemplate: "brochure_application_1",
    body: (name) => [
      name,
      "Thanks for downloading the DealSchool Fellowship brochure.",
      "application",
      "If you have any questions before applying, just reply to this message—we're happy to help.",
      "application by clicking Apply Now.",
    ],
  },
  2: {
    name: "brochure_application_2_new",
    emailTemplate: "brochure_application_2",
    body: (name) => [
      name,
      "Just checking in to see if you had a chance to go through the brochure.",
      "If you're considering applying and have any questions, feel free to reply here.",
      "application",
      "application by clicking Apply Now.",
    ],
  },
  3: {
    name: "brochure_application_3",
    emailTemplate: "brochure_application_3",
    body: (name) => [
      name,
      "one last message from us 👋",
      "begin your DealSchool journey today.",
      "If you think DealSchool could be the right fit for you, we'd love to review your application.",
      "we'll look forward to hearing from you.",
      "application by clicking Apply Now.",
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

// Called by the cron-triggered routes at /cron/brochure-reminders/[1h|24h|36h].
// Query is (reminderStage, createdAt<=threshold) rather than a tight time
// window — a late or missed cron run still picks up every request that has
// crossed the threshold and hasn't had this stage's message sent yet.
export async function runBrochureReminder(
  stage: ReminderStage,
  opts: { force?: boolean; testId?: string } = {}
): Promise<ReminderRunResult> {
  const prevStage = stage - 1;
  const template = STAGE_TEMPLATES[stage];
  // force=true (local/manual testing only) bypasses the age threshold — pair
  // it with testId so it only ever touches that one document (see cron-test-scope.ts).
  const threshold = opts.force ? FORCE_BYPASS_THRESHOLD : new Date(Date.now() - STAGE_HOURS[stage] * 60 * 60 * 1000);

  const collectionRef = adminDb.collection("brochureRequests");
  const query = collectionRef
    .where("reminderStage", "==", prevStage)
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
  let emailSent = 0;
  let emailFailed = 0;
  let skippedNoEmail = 0;

  await runWithConcurrency(docs, CONCURRENCY, async (doc) => {
    const data = doc.data();
    const name    = data.name || "there";
    const contact = data.contact;
    const email   = data.email;

    if (!contact) {
      skippedNoPhone += 1;
      logWarn("brochure-reminders", "Request has no contact number, skipping", { requestId: doc.id, stage });
      return;
    }

    try {
      await sendWhatsAppTemplate({
        to: toWhatsAppId(String(contact)),
        templateName: template.name,
        bodyParams: template.body(String(name)),
        buttonUrl: APPLY_URL,
      });
      await doc.ref.update({ reminderStage: stage, lastReminderSentAt: FieldValue.serverTimestamp() });
      sent += 1;
    } catch (err) {
      failed += 1;
      logError("brochure-reminders", `Reminder failed requestId=${doc.id} stage=${stage}`, err);
    }

    // Email tracks its own progression (emailReminderStage) independent of
    // reminderStage above — see incomplete-applicant-reminders.ts for why a
    // stuck WhatsApp send would otherwise refire this stage's email on every
    // cron tick instead of once.
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
      logError("brochure-reminders", `Email reminder failed requestId=${doc.id} stage=${stage}`, err);
    }
  });

  const result: ReminderRunResult = { stage, matched: docs.length, sent, failed, skippedNoPhone, emailSent, emailFailed, skippedNoEmail };
  logInfo("brochure-reminders", "Run complete", result as unknown as Record<string, unknown>);
  return result;
}
