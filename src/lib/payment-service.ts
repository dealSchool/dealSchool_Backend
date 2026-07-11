import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { createPaymentLink } from "./cashfree";
import { getCohortSettings } from "./cohort-settings";
import { sendEmail } from "./mailer";
import { renderPaymentLinkEmail } from "./email-templates";
import { logInfo, logWarn, logError } from "./logger";

const CANDIDATE_SENDER = "DealSchool <support@dealschool.in>";

export interface PaymentLinkData {
  linkId:    string;
  linkUrl:   string;
  expiresAt: Timestamp;
  feePaise:  number;
}

/**
 * Creates a Cashfree payment link and returns the data — NO Firebase writes.
 * Throws on failure so the caller can decide whether to abort the DB update.
 */
export async function createCashfreePaymentLink(
  applicationId: string,
  appData: { fullName?: string; email?: string; mobileNumber?: string },
): Promise<PaymentLinkData> {
  const { feePaise } = await getCohortSettings();
  // Normalize to exactly one trailing slash regardless of whether
  // APP_BASE_URL was set with or without one — a bare .replace(/\/$/, "/")
  // is a no-op when there's no existing trailing slash to replace.
  const appBaseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "") + "/";

  const paymentLink = await createPaymentLink({
    linkId:      `${applicationId}_${Date.now()}`,
    amountPaise: feePaise,
    purpose:     "DealSchool Fellowship Program Fee",
    customer: {
      name:  String(appData.fullName || ""),
      email: String(appData.email    || ""),
      phone: String(appData.mobileNumber || ""),
    },
    notes:     { applicationId, source: "dealschool-auto" },
    notifyUrl: `${appBaseUrl}webhooks/cashfree`,
  });

  return {
    linkId:    paymentLink.linkId,
    linkUrl:   paymentLink.linkUrl,
    expiresAt: Timestamp.fromDate(paymentLink.expiresAt),
    feePaise,
  };
}

export async function createAndSendPaymentLink(applicationId: string): Promise<void> {
  const appRef = adminDb.collection("applications").doc(applicationId);

  // Optimistic lock — only one execution proceeds; allow retry on error/expired/stuck-processing
  const retryable = new Set(["error", "expired", "failed", "link_sent", "processing"]);
  let skip = false;

  await adminDb.runTransaction(async (t) => {
    const doc = await t.get(appRef);
    const d = doc.data();
    if (!d) { skip = true; return; }
    const ps = d.paymentStatus;
    if (ps && !retryable.has(ps)) { skip = true; return; }
    t.update(appRef, { paymentStatus: "processing" });
  });

  if (skip) return;

  const appSnap = await appRef.get();
  const appData = appSnap.data();
  if (!appData) {
    await appRef.update({ paymentStatus: "error" });
    return;
  }

  let link: PaymentLinkData;
  try {
    link = await createCashfreePaymentLink(applicationId, appData);
    logInfo("payment-service", "Cashfree payment link created", { applicationId, linkId: link.linkId, linkUrl: link.linkUrl, feePaise: String(link.feePaise) });
  } catch (err: unknown) {
    logError("payment-service", `Cashfree link creation FAILED applicationId=${applicationId}`, err);
    await appRef.update({ paymentStatus: "error" });
    return;
  }

  const { linkId, linkUrl, expiresAt, feePaise } = link;

  await adminDb.collection("payments").doc(applicationId).set({
    applicationId,
    applicantName:    appData.fullName     || "",
    applicantEmail:   appData.email        || "",
    applicantPhone:   appData.mobileNumber || "",
    amount:           feePaise,
    currency:         "INR",
    paymentLinkId:    linkId,
    paymentLinkUrl:   linkUrl,
    status:           "link_created",
    expiresAt,
    processedWebhookIds: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await appRef.update({
    paymentStatus:     "link_sent",
    paymentLinkId:     linkId,
    paymentLinkSentAt: FieldValue.serverTimestamp(),
    updatedAt:         FieldValue.serverTimestamp(),
  });

  const feeDisplay      = `₹${(feePaise / 100).toFixed(0)}`;
  const recipientEmail  = String(appData.email || "");

  if (!recipientEmail) {
    logWarn("payment-service", "Applicant has no email — payment link email skipped", { applicationId });
    return;
  }

  logInfo("payment-service", "Sending payment link email", { applicationId, recipientEmail, feeDisplay });

  try {
    await sendEmail({
      from:    CANDIDATE_SENDER,
      to:      recipientEmail,
      subject: "Your DealSchool Fellowship Offer: Action Required",
      html:    renderPaymentLinkEmail({ fullName: String(appData.fullName || ""), linkUrl, feeDisplay }),
    });
    logInfo("payment-service", "Payment link email sent OK", { applicationId, recipientEmail });
    await adminDb.collection("payments").doc(applicationId).update({
      emailSentAt: FieldValue.serverTimestamp(),
    });
  } catch (err: unknown) {
    logError("payment-service", `Payment link email FAILED — applicant did NOT receive payment link | applicationId=${applicationId} recipientEmail=${recipientEmail}`, err);
  }
}
