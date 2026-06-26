import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { getRazorpay } from "./razorpay";
import { sendEmail } from "./mailer";
import { renderPaymentLinkEmail } from "./email-templates";

const CANDIDATE_SENDER = "DealSchool <admin@dealschool.in>";

export interface PaymentLinkData {
  linkId:    string;
  linkUrl:   string;
  expiresAt: Timestamp;
  feePaise:  number;
}

/**
 * Creates a Razorpay payment link and returns the data — NO Firebase writes.
 * Throws on failure so the caller can decide whether to abort the DB update.
 */
export async function createRazorpayPaymentLink(
  applicationId: string,
  appData: { fullName?: string; email?: string; mobileNumber?: string },
): Promise<PaymentLinkData> {
  const feePaise   = parseInt(process.env.FELLOWSHIP_FEE || "100", 10) * 100;
  const appBaseUrl = (process.env.APP_BASE_URL || "http://localhost:3000/").replace(/\/$/, "/");
  const expiryUnix = Math.floor(Date.now() / 1000) + 1800;

  const rzp         = getRazorpay();
  const paymentLink = await rzp.paymentLink.create({
    amount:       feePaise,
    currency:     "INR",
    description:  "DealSchool Fellowship Program Fee",
    reference_id: `${applicationId}_${Date.now()}`,
    expire_by:    expiryUnix,
    customer: {
      name:  String(appData.fullName  || ""),
      email: String(appData.email     || ""),
      ...(appData.mobileNumber ? { contact: String(appData.mobileNumber) } : {}),
    },
    notify:          { sms: false, email: false },
    reminder_enable: false,
    callback_url:    appBaseUrl,
    callback_method: "get",
    notes:           { applicationId, source: "dealschool-auto" },
    options: {
      checkout: {
        method: {
          upi:        1,
          card:       1,
          netbanking: 1,
          wallet:     1,
          paylater:   1,
        },
      },
    },
  } as any);

  return {
    linkId:    paymentLink.id,
    linkUrl:   paymentLink.short_url,
    expiresAt: Timestamp.fromDate(new Date((paymentLink.expire_by as number) * 1000)),
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
    link = await createRazorpayPaymentLink(applicationId, appData);
  } catch (err: any) {
    console.error("[payment-service] Razorpay error:", err?.error || err?.message);
    await appRef.update({ paymentStatus: "error" });
    return;
  }

  const { linkId, linkUrl, expiresAt, feePaise } = link;

  await adminDb.collection("payments").doc(applicationId).set({
    applicationId,
    applicantName:     appData.fullName     || "",
    applicantEmail:    appData.email        || "",
    applicantPhone:    appData.mobileNumber || "",
    amount:            feePaise,
    currency:          "INR",
    rzpPaymentLinkId:  linkId,
    rzpPaymentLinkUrl: linkUrl,
    status:            "link_created",
    expiresAt,
    processedWebhookIds: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await appRef.update({
    paymentStatus:     "link_sent",
    rzpPaymentLinkId:  linkId,
    paymentLinkSentAt: FieldValue.serverTimestamp(),
    updatedAt:         FieldValue.serverTimestamp(),
  });

  const feeDisplay = `₹${(feePaise / 100).toFixed(0)}`;
  const recipientEmail = String(appData.email || "");

  console.log(`[payment-service] Sending payment link email to: ${recipientEmail}`);

  try {
    await sendEmail({
      from:    CANDIDATE_SENDER,
      to:      recipientEmail,
      subject: "Your DealSchool Fellowship Offer — Action Required",
      html:    renderPaymentLinkEmail({ fullName: String(appData.fullName || ""), linkUrl, feeDisplay }),
    });
    console.log(`[payment-service] Email sent successfully to: ${recipientEmail}`);
    await adminDb.collection("payments").doc(applicationId).update({
      emailSentAt: FieldValue.serverTimestamp(),
    });
  } catch (err: any) {
    console.error(`[payment-service] Email FAILED for ${recipientEmail}:`, err?.message || err);
  }
}
