import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { sendWhatsAppTemplate, toWhatsAppId } from "@/lib/cheerio-whatsapp";
import { resolveCronDocs, FORCE_BYPASS_THRESHOLD } from "@/lib/cron-test-scope";

const REMINDER_HOURS = 24; // after paymentLinkSentAt, if still unpaid
const TEMPLATE_NAME = "payment_reminder_new";

function bodyParams(fullName: string): string[] {
  return [
    fullName,
    "admission payment hasn't been completed yet.",
    "Your seat is currently reserved, but since the cohort has limited seats, we'd request you to complete the payment at the earliest to confirm your admission.",
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

export interface PaymentReminderRunResult {
  matched: number;
  sent: number;
  failed: number;
  skippedNoPhone: number;
  skippedNoLink: number;
}

// Called by the cron-triggered route at /cron/payment-reminder — runs once
// daily. Query is (status, paymentStatus, paymentReminderSent,
// paymentLinkSentAt<=threshold) — a late or missed cron run still picks up
// every accepted-but-unpaid application that crossed the 24h mark and hasn't
// been messaged yet. Re-accepting after a cancellation resets
// paymentReminderSent (see PATCH /applications/[id]), so the timer restarts.
//
// The actual Cashfree payment link URL lives on the "payments" collection
// (not on "applications" itself — see payment-service.ts), so each match
// needs a follow-up read of payments/{id} to get the button URL.
export async function runPaymentReminder(
  opts: { force?: boolean; testId?: string } = {}
): Promise<PaymentReminderRunResult> {
  // force=true (local/manual testing only) bypasses the age threshold — pair
  // it with testId so it only ever touches that one document (see cron-test-scope.ts).
  const threshold = opts.force ? FORCE_BYPASS_THRESHOLD : new Date(Date.now() - REMINDER_HOURS * 60 * 60 * 1000);

  const collectionRef = adminDb.collection("applications");
  const query = collectionRef
    .where("status", "==", "accepted")
    .where("paymentStatus", "==", "link_sent")
    .where("paymentReminderSent", "==", false)
    .where("paymentLinkSentAt", "<=", threshold)
    // Explicit oldest-first order — see incomplete-applicant-reminders.ts for
    // why this matters once a backlog can exceed BATCH_CAP. Same existing
    // composite index, no new index needed.
    .orderBy("paymentLinkSentAt", "asc")
    .limit(BATCH_CAP);
  const docs = await resolveCronDocs(collectionRef, query, opts.testId);

  let sent = 0;
  let failed = 0;
  let skippedNoPhone = 0;
  let skippedNoLink = 0;

  await runWithConcurrency(docs, CONCURRENCY, async (doc) => {
    const data = doc.data();
    const fullName     = data.fullName || "there";
    const mobileNumber = data.mobileNumber;

    if (!mobileNumber) {
      skippedNoPhone += 1;
      logWarn("payment-reminder", "Application has no mobileNumber, skipping", { applicationId: doc.id });
      return;
    }

    const paymentSnap = await adminDb.collection("payments").doc(doc.id).get();
    const paymentLinkUrl = paymentSnap.data()?.paymentLinkUrl;

    if (!paymentLinkUrl) {
      skippedNoLink += 1;
      logWarn("payment-reminder", "No paymentLinkUrl found, skipping", { applicationId: doc.id });
      return;
    }

    try {
      await sendWhatsAppTemplate({
        to: toWhatsAppId(String(mobileNumber)),
        templateName: TEMPLATE_NAME,
        bodyParams: bodyParams(String(fullName)),
        buttonUrl: String(paymentLinkUrl),
      });
      await doc.ref.update({ paymentReminderSent: true, paymentReminderSentAt: FieldValue.serverTimestamp() });
      sent += 1;
    } catch (err) {
      failed += 1;
      logError("payment-reminder", `Reminder failed applicationId=${doc.id}`, err);
    }
  });

  const result: PaymentReminderRunResult = { matched: docs.length, sent, failed, skippedNoPhone, skippedNoLink };
  logInfo("payment-reminder", "Run complete", result as unknown as Record<string, unknown>);
  return result;
}
