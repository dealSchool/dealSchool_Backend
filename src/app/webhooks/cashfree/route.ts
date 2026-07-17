import { NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { fetchPaymentLink, fetchOrderPayments, describePaymentMethod, verifyCashfreeWebhookSignature } from "@/lib/cashfree";
import {
  renderPaymentReceiptEmail,
  renderPaymentReceiptAdminEmail,
  renderRefundCompletedEmail,
  renderRefundAdminNotification,
} from "@/lib/email-templates";
import { sendEmail } from "@/lib/mailer";
import { getNextInvoiceNumber, generateInvoicePdf } from "@/lib/invoice";
import { logInfo, logWarn, logError } from "@/lib/logger";

export const runtime = "nodejs";

const CANDIDATE_SENDER = "DealSchool <support@dealschool.in>";

// Cashfree's refund object doesn't carry arbitrary notes like Razorpay's did,
// so we resolve applicationId by looking up which payments doc has this
// refund_id stored (written at refund-initiation time — see
// src/app/applications/[id]/cancel/route.ts) instead of parsing it out of
// the id string, which would be fragile for ids ending in digits.
async function applicationIdForRefundId(refundId: string): Promise<string> {
  const snap = await adminDb.collection("payments").where("refundId", "==", refundId).limit(1).get();
  return snap.empty ? "" : snap.docs[0].id;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  logInfo("api/webhooks/cashfree", "Webhook POST received", { bodyLength: rawBody.length });

  const incomingSig = request.headers.get("x-webhook-signature");
  const timestamp    = request.headers.get("x-webhook-timestamp");
  if (!incomingSig || !timestamp) {
    logWarn("api/webhooks/cashfree", "Missing x-webhook-signature/x-webhook-timestamp header — rejected");
    return new Response("Missing signature", { status: 400 });
  }

  const sigValid = await verifyCashfreeWebhookSignature(rawBody, timestamp, incomingSig);
  if (!sigValid) {
    logError("api/webhooks/cashfree", "Signature verification FAILED — check the active mode's CASHFREE_SECRET_KEY matches the Cashfree dashboard");
    return new Response("Invalid signature", { status: 400 });
  }

  const event: any    = JSON.parse(rawBody);
  const eventType: string = event.type || "";
  logInfo("api/webhooks/cashfree", "Signature verified", { eventType });

  // ─── PAYMENT_LINK_EVENT ────────────────────────────────────────────────────────
  if (eventType === "PAYMENT_LINK_EVENT") {
    const data = event.data;
    const linkStatus: string = data?.link_status || "";

    if (linkStatus === "PAID") {
      const paymentLinkId: string = data.link_id;
      const orderId: string | undefined = data.order?.order_id;
      const paidAmountPaise: number = Math.round(Number(data.link_amount_paid) * 100);
      const applicationId: string = data.link_notes?.applicationId || "";

      logInfo("api/webhooks/cashfree", "PAYMENT_LINK_EVENT (PAID) parsed", { applicationId, paymentLinkId, orderId, paidAmountPaise });

      if (!applicationId || !orderId) {
        logWarn("api/webhooks/cashfree", "Cannot resolve applicationId/orderId from webhook payload — skipping", { paymentLinkId });
        return new Response("OK", { status: 200 });
      }

      const paymentRef = adminDb.collection("payments").doc(applicationId);
      const appRef      = adminDb.collection("applications").doc(applicationId);

      const paymentSnap = await paymentRef.get();
      const storedFee    = paymentSnap.exists ? (paymentSnap.data()!.amount as number | undefined) : undefined;
      const feePaise     = storedFee ?? parseInt(process.env.FELLOWSHIP_FEE || "100", 10) * 100;

      // ── Cross-verify with Cashfree API BEFORE touching Firestore ──────────────
      try {
        const linkDetails = await fetchPaymentLink(paymentLinkId);
        const linkAmountPaise = Math.round(Number(linkDetails.link_amount) * 100);

        logInfo("api/webhooks/cashfree", "Cashfree cross-verify result", {
          linkStatus: linkDetails.link_status,
          linkAmountPaise: String(linkAmountPaise),
          expectedFee: String(feePaise),
        });

        if (linkDetails.link_status !== "PAID") {
          logWarn("api/webhooks/cashfree", `Cross-verify: link status "${linkDetails.link_status}" ≠ "PAID" — skipping`, { applicationId });
          return new Response("OK", { status: 200 });
        }
        if (linkAmountPaise !== feePaise) {
          logWarn("api/webhooks/cashfree", "Cross-verify: amount mismatch — skipping", {
            applicationId,
            cashfreeAmountPaise: String(linkAmountPaise),
            expectedFee:         String(feePaise),
            hint: "FELLOWSHIP_FEE env var may not match the fee the payment link was created with",
          });
          return new Response("OK", { status: 200 });
        }
      } catch (err: unknown) {
        logError("api/webhooks/cashfree", `Cashfree cross-verify API call FAILED applicationId=${applicationId}`, err);
        return new Response("OK", { status: 200 });
      }

      // ── Fetch payment method / transaction details ───────────────────────────
      // The PAYMENT_LINK_EVENT payload's order object has no payment-method or
      // timestamp fields — that detail only exists via this separate API call.
      // Best-effort: a failure here shouldn't block marking the payment paid.
      const cfLinkId: string | number | null = data.cf_link_id ?? null;
      let cfPaymentId: string | number | null = null;
      let paymentMethodLabel = "N/A";
      let paymentMethodRaw: unknown = null;
      let bankReference: string | null = null;
      let paymentTime: string | null = null;
      try {
        const payments = await fetchOrderPayments(orderId);
        const successPayment = payments.find((p: any) => p.payment_status === "SUCCESS");
        if (successPayment) {
          cfPaymentId        = successPayment.cf_payment_id ?? null;
          paymentMethodRaw    = successPayment.payment_method ?? null;
          paymentMethodLabel  = describePaymentMethod(successPayment.payment_method);
          bankReference       = successPayment.bank_reference ?? null;
          paymentTime         = successPayment.payment_time ?? null;
        }
      } catch (err: unknown) {
        logWarn("api/webhooks/cashfree", `Could not fetch order payments for method details applicationId=${applicationId} orderId=${orderId}`);
      }

      // ── Atomic idempotent write ────────────────────────────────────────────────
      // Cashfree doesn't send a top-level event id like Razorpay's `event.id`;
      // orderId is unique per real-world paid occurrence, so it doubles as the
      // idempotency key.
      const webhookEventId = `paid_${orderId}`;
      let transactionDidWrite = false;
      await adminDb.runTransaction(async (t) => {
        transactionDidWrite = false;

        const snap = await t.get(paymentRef);
        if (snap.exists) {
          const d = snap.data()!;
          const seen = (d.processedWebhookIds as string[] | undefined) ?? [];
          if (seen.includes(webhookEventId)) {
            logInfo("api/webhooks/cashfree", "Duplicate webhook event — skipping (idempotency)", { webhookEventId, applicationId });
            return;
          }
          if (d.status === "paid") {
            logInfo("api/webhooks/cashfree", "Application already marked paid — skipping", { applicationId });
            return;
          }
        }

        t.set(paymentRef, {
          paymentOrderId: orderId,
          cfLinkId,
          cfPaymentId,
          paymentMethod:    paymentMethodLabel,
          paymentMethodRaw,
          bankReference,
          paymentTime,
          status:    "paid",
          paidAt:    FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          processedWebhookIds: FieldValue.arrayUnion(webhookEventId),
        }, { merge: true });

        t.set(appRef, {
          paymentStatus: "paid",
          paymentOrderId: orderId,
          paidAt:    FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        transactionDidWrite = true;
      });

      if (!transactionDidWrite) {
        return new Response("OK", { status: 200 });
      }

      logInfo("api/webhooks/cashfree", "Firestore updated — application marked as paid", { applicationId, orderId });

      // ── Send emails (non-fatal, DB already committed) ────────────────────────
      const appSnap  = await appRef.get();
      const appData  = appSnap.data();
      const feeDisplay = `₹${(feePaise / 100).toFixed(0)}`;
      const adminEmail = process.env.NOTIFICATION_EMAIL || "support@dealschool.in";

      if (!appData?.email) {
        logWarn("api/webhooks/cashfree", "Applicant has no email address — payment receipt skipped", { applicationId });
      } else {
        const paymentMethod = paymentMethodLabel;
        const paymentDate   = paymentTime ? new Date(paymentTime) : new Date();
        const paidOnDisplay = paymentDate.toLocaleString("en-IN", {
          day: "2-digit", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
          timeZone: "Asia/Kolkata",
        }) + " IST";

        // Invoice PDF attachment — non-fatal, the receipt still sends without it if generation fails.
        let invoiceAttachment: { filename: string; content: Buffer }[] | undefined;
        try {
          const invoiceNumber = await getNextInvoiceNumber(paymentDate);
          const pdf = await generateInvoicePdf({
            invoiceNumber,
            applicantName:  String(appData.fullName || "Fellow"),
            applicantEmail: String(appData.email),
            amountDisplay:  feeDisplay,
            paymentDate,
            paymentMethod,
            paymentId: orderId,
          });
          invoiceAttachment = [{ filename: `${invoiceNumber}.pdf`, content: pdf }];

          const invoiceRecord = {
            invoiceNumber,
            invoicePaymentMethod: paymentMethod,
            invoiceGeneratedAt: FieldValue.serverTimestamp(),
          };
          Promise.all([
            appRef.set(invoiceRecord, { merge: true }),
            paymentRef.set(invoiceRecord, { merge: true }),
          ]).catch((err) => logError("api/webhooks/cashfree", `Invoice record persistence FAILED applicationId=${applicationId} invoiceNumber=${invoiceNumber}`, err));
        } catch (err: unknown) {
          logError("api/webhooks/cashfree", `Invoice generation FAILED applicationId=${applicationId}`, err);
        }

        logInfo("api/webhooks/cashfree", "Sending payment receipt email", { applicationId, applicantEmail: appData.email });
        sendEmail({
          from:    CANDIDATE_SENDER,
          to:      String(appData.email),
          subject: "Payment Confirmed: Welcome to DealSchool!",
          html:    renderPaymentReceiptEmail({
            applicantName: String(appData.fullName || "Fellow"),
            feeDisplay,
            paymentId: orderId,
            paymentMethod,
            paidOnDisplay,
            applicantEmail: String(appData.email),
            mobileNumber: appData.mobileNumber ? String(appData.mobileNumber) : undefined,
          }),
          attachments: invoiceAttachment,
        })
          .then(() => logInfo("api/webhooks/cashfree", "Payment receipt email sent OK", { applicationId, applicantEmail: appData.email }))
          .catch((err) => logError("api/webhooks/cashfree", `Payment receipt email FAILED applicationId=${applicationId} applicantEmail=${appData.email}`, err));

        logInfo("api/webhooks/cashfree", "Sending admin payment notification", { applicationId, adminEmail });
        sendEmail({
          from:    CANDIDATE_SENDER,
          to:      adminEmail,
          subject: `[Payment Confirmed] ${String(appData.fullName || "Fellow")}: ${feeDisplay}`,
          html:    renderPaymentReceiptAdminEmail({
            applicantName:  String(appData.fullName || "Fellow"),
            applicantEmail: String(appData.email),
            feeDisplay,
            paymentId: orderId,
            applicationId,
          }),
        })
          .then(() => logInfo("api/webhooks/cashfree", "Admin payment notification sent OK", { applicationId, adminEmail }))
          .catch((err) => logError("api/webhooks/cashfree", `Admin payment notification FAILED applicationId=${applicationId} adminEmail=${adminEmail}`, err));
      }

    // ─── link expired ────────────────────────────────────────────────────────────
    } else if (linkStatus === "EXPIRED") {
      const applicationId: string = data?.link_notes?.applicationId || "";
      if (!applicationId) return new Response("OK", { status: 200 });

      logInfo("api/webhooks/cashfree", "PAYMENT_LINK_EVENT (EXPIRED)", { applicationId });

      await adminDb.collection("payments").doc(applicationId).set(
        { status: "expired", updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      await adminDb.collection("applications").doc(applicationId).set(
        { paymentStatus: "expired", updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      logInfo("api/webhooks/cashfree", "Payment link marked expired in Firestore", { applicationId });

    // ─── link cancelled / partially paid — not used by this app, log only ────────
    } else {
      logInfo("api/webhooks/cashfree", "PAYMENT_LINK_EVENT — unhandled link_status, ignored", { linkStatus });
    }

  // ─── REFUND_STATUS_WEBHOOK ─────────────────────────────────────────────────────
  // Fired asynchronously after /applications/[id]/cancel initiates a refund.
  } else if (eventType === "REFUND_STATUS_WEBHOOK") {
    const refund = event.data?.refund;
    if (!refund) return new Response("OK", { status: 200 });

    const refundStatus: string = refund.refund_status || "";
    if (refundStatus === "PENDING") {
      logInfo("api/webhooks/cashfree", "REFUND_STATUS_WEBHOOK (PENDING) — ignored", { refundId: refund.refund_id });
      return new Response("OK", { status: 200 });
    }

    const applicationId = await applicationIdForRefundId(String(refund.refund_id || ""));
    if (!applicationId) {
      logWarn("api/webhooks/cashfree", "Cannot resolve applicationId from refund webhook — skipping", { refundId: refund.refund_id });
      return new Response("OK", { status: 200 });
    }

    const isProcessed = refundStatus === "SUCCESS";
    const newStatus    = isProcessed ? "refunded" : "refund_failed";

    logInfo("api/webhooks/cashfree", "REFUND_STATUS_WEBHOOK parsed", { applicationId, refundId: refund.refund_id, refundStatus });

    const paymentRef = adminDb.collection("payments").doc(applicationId);
    const appRef      = adminDb.collection("applications").doc(applicationId);
    const webhookEventId = `refund_${refund.refund_id}_${refundStatus}`;

    let transactionDidWrite = false;
    await adminDb.runTransaction(async (t) => {
      transactionDidWrite = false;

      const snap = await t.get(paymentRef);
      if (snap.exists) {
        const d = snap.data()!;
        const seen = (d.processedWebhookIds as string[] | undefined) ?? [];
        if (seen.includes(webhookEventId)) {
          logInfo("api/webhooks/cashfree", "Duplicate refund webhook event — skipping (idempotency)", { webhookEventId, applicationId });
          return;
        }
        if (d.status === newStatus) {
          logInfo("api/webhooks/cashfree", "Refund status already applied — skipping", { applicationId, newStatus });
          return;
        }
        if (d.status === "refunded" && !isProcessed) {
          logWarn("api/webhooks/cashfree", "Ignoring refund_failed for an already-refunded payment (stale/out-of-order webhook)", { applicationId });
          return;
        }
      }

      t.set(paymentRef, {
        status:    newStatus,
        refundId:  refund.refund_id,
        ...(isProcessed ? { refundedAt: FieldValue.serverTimestamp() } : {}),
        updatedAt: FieldValue.serverTimestamp(),
        processedWebhookIds: FieldValue.arrayUnion(webhookEventId),
      }, { merge: true });

      t.set(appRef, {
        paymentStatus: newStatus,
        updatedAt:     FieldValue.serverTimestamp(),
      }, { merge: true });

      transactionDidWrite = true;
    });

    if (!transactionDidWrite) {
      return new Response("OK", { status: 200 });
    }

    logInfo("api/webhooks/cashfree", `Firestore updated — refund ${newStatus}`, { applicationId, refundId: refund.refund_id });

    // ── Send emails (non-fatal, DB already committed) ────────────────────────
    const appSnap           = await appRef.get();
    const appData           = appSnap.data();
    const refundAmountPaise = Math.round(Number(refund.refund_amount) * 100);
    const refundDisplay     = `₹${(refundAmountPaise / 100).toFixed(0)}`;
    const adminEmail        = process.env.NOTIFICATION_EMAIL || "support@dealschool.in";

    if (isProcessed && appData?.email) {
      logInfo("api/webhooks/cashfree", "Sending refund completed email", { applicationId, applicantEmail: appData.email });
      sendEmail({
        from:    CANDIDATE_SENDER,
        to:      String(appData.email),
        subject: "Your DealSchool Fellowship Refund Has Been Completed",
        html:    renderRefundCompletedEmail({
          applicantName: String(appData.fullName || "Fellow"),
          refundDisplay,
          refundId:      refund.refund_id,
        }),
      })
        .then(() => logInfo("api/webhooks/cashfree", "Refund completed email sent OK", { applicationId, applicantEmail: appData.email }))
        .catch((err) => logError("api/webhooks/cashfree", `Refund completed email FAILED applicationId=${applicationId}`, err));
    }

    logInfo("api/webhooks/cashfree", `Sending admin refund ${newStatus} notification`, { applicationId, adminEmail });
    sendEmail({
      from:    CANDIDATE_SENDER,
      to:      adminEmail,
      subject: `[Refund ${isProcessed ? "Completed" : "FAILED"}] ${String(appData?.fullName || "Fellow")}: ${refundDisplay}`,
      html:    renderRefundAdminNotification({
        applicantName:  String(appData?.fullName || "Fellow"),
        applicantEmail: String(appData?.email || ""),
        applicationId,
        status:         isProcessed ? "completed" : "failed",
        refundDisplay,
        refundPercent:  Number(appData?.refundPercent ?? 0),
        refundId:       refund.refund_id,
      }),
    }).catch((err) => logError("api/webhooks/cashfree", `Refund admin notification FAILED applicationId=${applicationId}`, err));

  } else {
    logInfo("api/webhooks/cashfree", "Unhandled event type — ignored", { eventType });
  }

  return new Response("OK", { status: 200 });
}
