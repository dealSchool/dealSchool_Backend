import { NextRequest } from "next/server";
import * as crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { getRazorpay } from "@/lib/razorpay";
import { renderPaymentReceiptEmail, renderPaymentReceiptAdminEmail } from "@/lib/email-templates";
import { sendEmail } from "@/lib/mailer";
import { logInfo, logWarn, logError } from "@/lib/logger";

export const runtime = "nodejs";

const CANDIDATE_SENDER = "DealSchool <admin@dealschool.in>";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  logInfo("api/webhooks/razorpay", "Webhook POST received", { bodyLength: rawBody.length });

  const incomingSig = request.headers.get("x-razorpay-signature");
  if (!incomingSig) {
    logWarn("api/webhooks/razorpay", "Missing x-razorpay-signature header — rejected");
    return new Response("Missing signature", { status: 400 });
  }

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logError("api/webhooks/razorpay", "RAZORPAY_WEBHOOK_SECRET not set in environment — cannot verify signature");
    return new Response("Server misconfiguration", { status: 500 });
  }

  // ── Signature verification ──────────────────────────────────────────────────
  const expectedSig = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  let sigValid = false;
  try {
    const expectedBuf = Buffer.from(expectedSig, "hex");
    const incomingBuf = Buffer.from(incomingSig, "hex");
    sigValid =
      expectedBuf.length === incomingBuf.length &&
      crypto.timingSafeEqual(expectedBuf, incomingBuf);
  } catch {
    sigValid = false;
  }

  if (!sigValid) {
    logError("api/webhooks/razorpay", "Signature verification FAILED — check RAZORPAY_WEBHOOK_SECRET matches Razorpay dashboard → Settings → Webhooks");
    return new Response("Invalid signature", { status: 400 });
  }

  const event           = JSON.parse(rawBody);
  const eventType:      string = event.event || "";
  const webhookEventId: string = event.id    || "";
  logInfo("api/webhooks/razorpay", "Signature verified", { eventType, webhookEventId });

  // ─── payment_link.paid ───────────────────────────────────────────────────────
  if (eventType === "payment_link.paid") {
    const paymentEntity = event.payload?.payment?.entity;
    const linkEntity    = event.payload?.payment_link?.entity;

    if (!paymentEntity || !linkEntity) {
      console.warn("[webhook] Payload missing paymentEntity or linkEntity");
      return new Response("OK", { status: 200 });
    }

    const rzpPaymentId:     string = paymentEntity.id;
    const rzpPaymentLinkId: string = linkEntity.id;
    const paidAmountPaise:  number = paymentEntity.amount;
    const applicationId:    string =
      linkEntity.notes?.applicationId || linkEntity.reference_id || "";

    logInfo("api/webhooks/razorpay", "payment_link.paid payload parsed", { applicationId, rzpPaymentLinkId, rzpPaymentId, paidAmountPaise });

    if (!applicationId) {
      logWarn("api/webhooks/razorpay", "Cannot resolve applicationId from webhook payload — skipping", { rzpPaymentLinkId });
      return new Response("OK", { status: 200 });
    }

    const paymentRef = adminDb.collection("payments").doc(applicationId);
    const appRef     = adminDb.collection("applications").doc(applicationId);

    // ── Cross-verify with Razorpay API BEFORE touching Firestore ────────────
    // Use the fee stored in the payments doc so an env-var change can't silently
    // block legitimate payments that were created at the old fee.
    const paymentSnap = await paymentRef.get();
    const storedFee   = paymentSnap.exists
      ? (paymentSnap.data()!.amount as number | undefined)
      : undefined;
    const feePaise    = storedFee ?? parseInt(process.env.FELLOWSHIP_FEE || "100", 10) * 100;

    try {
      const rzp         = getRazorpay();
      const linkDetails = await rzp.paymentLink.fetch(rzpPaymentLinkId);

      logInfo("api/webhooks/razorpay", "Razorpay cross-verify result", {
        linkStatus: linkDetails.status,
        linkAmount:  String(linkDetails.amount),
        expectedFee: String(feePaise),
      });

      if (linkDetails.status !== "paid") {
        logWarn("api/webhooks/razorpay", `Cross-verify: link status "${linkDetails.status}" ≠ "paid" — skipping`, { applicationId });
        return new Response("OK", { status: 200 });
      }
      if ((linkDetails.amount as number) !== feePaise) {
        logWarn("api/webhooks/razorpay", `Cross-verify: amount mismatch — skipping`, {
          applicationId,
          razorpayAmount: String(linkDetails.amount),
          expectedFee:    String(feePaise),
          hint: "FELLOWSHIP_FEE env var may not match the fee the payment link was created with",
        });
        return new Response("OK", { status: 200 });
      }
    } catch (err: unknown) {
      logError("api/webhooks/razorpay", `Razorpay cross-verify API call FAILED applicationId=${applicationId}`, err);
      return new Response("OK", { status: 200 });
    }

    // ── Atomic idempotent write ──────────────────────────────────────────────
    // Idempotency check is INSIDE the transaction so simultaneous webhook
    // deliveries cannot both pass and send duplicate emails.
    let transactionDidWrite = false;
    await adminDb.runTransaction(async (t) => {
      transactionDidWrite = false; // reset on each retry attempt

      const snap = await t.get(paymentRef);
      if (snap.exists) {
        const d = snap.data()!;
        const seen = (d.processedWebhookIds as string[] | undefined) ?? [];
        if (seen.includes(webhookEventId)) {
          logInfo("api/webhooks/razorpay", "Duplicate webhook event — skipping (idempotency)", { webhookEventId, applicationId });
          return;
        }
        if (d.status === "paid") {
          logInfo("api/webhooks/razorpay", "Application already marked paid — skipping", { applicationId });
          return;
        }
      }

      t.set(paymentRef, {
        rzpPaymentId,
        status:    "paid",
        paidAt:    FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        processedWebhookIds: FieldValue.arrayUnion(webhookEventId),
      }, { merge: true });

      t.set(appRef, {
        paymentStatus: "paid",
        rzpPaymentId,
        paidAt:    FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      transactionDidWrite = true;
    });

    if (!transactionDidWrite) {
      return new Response("OK", { status: 200 });
    }

    logInfo("api/webhooks/razorpay", "Firestore updated — application marked as paid", { applicationId, rzpPaymentId });

    // suppress unused variable warning
    void paidAmountPaise;

    // ── Send emails (non-fatal, DB already committed) ────────────────────────
    const appSnap  = await appRef.get();
    const appData  = appSnap.data();
    const feeDisplay = `₹${(feePaise / 100).toFixed(0)}`;
    const adminEmail = process.env.ADMIN_EMAIL || "admin@dealschool.in";

    if (!appData?.email) {
      logWarn("api/webhooks/razorpay", "Applicant has no email address — payment receipt skipped", { applicationId });
    } else {
      logInfo("api/webhooks/razorpay", "Sending payment receipt email", { applicationId, applicantEmail: appData.email });
      sendEmail({
        from:    CANDIDATE_SENDER,
        to:      String(appData.email),
        subject: "Payment Confirmed — Welcome to DealSchool!",
        html:    renderPaymentReceiptEmail({
          applicantName: String(appData.fullName || "Fellow"),
          feeDisplay,
          rzpPaymentId,
        }),
      })
        .then(() => logInfo("api/webhooks/razorpay", "Payment receipt email sent OK", { applicationId, applicantEmail: appData.email }))
        .catch((err) => logError("api/webhooks/razorpay", `Payment receipt email FAILED applicationId=${applicationId} applicantEmail=${appData.email}`, err));

      logInfo("api/webhooks/razorpay", "Sending admin payment notification", { applicationId, adminEmail });
      sendEmail({
        from:    CANDIDATE_SENDER,
        to:      adminEmail,
        subject: `[Payment Confirmed] ${String(appData.fullName || "Fellow")} — ${feeDisplay}`,
        html:    renderPaymentReceiptAdminEmail({
          applicantName:  String(appData.fullName || "Fellow"),
          applicantEmail: String(appData.email),
          feeDisplay,
          rzpPaymentId,
          applicationId,
        }),
      })
        .then(() => logInfo("api/webhooks/razorpay", "Admin payment notification sent OK", { applicationId, adminEmail }))
        .catch((err) => logError("api/webhooks/razorpay", `Admin payment notification FAILED applicationId=${applicationId} adminEmail=${adminEmail}`, err));
    }

  // ─── payment_link.expired ────────────────────────────────────────────────────
  } else if (eventType === "payment_link.expired") {
    const linkEntity = event.payload?.payment_link?.entity;
    if (!linkEntity) return new Response("OK", { status: 200 });

    const applicationId: string =
      linkEntity.notes?.applicationId || linkEntity.reference_id || "";
    if (!applicationId) return new Response("OK", { status: 200 });

    logInfo("api/webhooks/razorpay", "payment_link.expired", { applicationId });

    await adminDb.collection("payments").doc(applicationId).set(
      { status: "expired", updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    await adminDb.collection("applications").doc(applicationId).set(
      { paymentStatus: "expired", updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    logInfo("api/webhooks/razorpay", "Payment link marked expired in Firestore", { applicationId });

  } else {
    logInfo("api/webhooks/razorpay", "Unhandled event type — ignored", { eventType, webhookEventId });
  }

  return new Response("OK", { status: 200 });
}
