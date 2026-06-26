import { NextRequest } from "next/server";
import * as crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { getRazorpay } from "@/lib/razorpay";
import { renderPaymentReceiptEmail, renderPaymentReceiptAdminEmail } from "@/lib/email-templates";
import { sendEmail } from "@/lib/mailer";

export const runtime = "nodejs";

const CANDIDATE_SENDER = "DealSchool <admin@dealschool.in>";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const incomingSig = request.headers.get("x-razorpay-signature");
  if (!incomingSig) {
    console.error("[webhook] Missing x-razorpay-signature header");
    return new Response("Missing signature", { status: 400 });
  }

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[webhook] RAZORPAY_WEBHOOK_SECRET env var is not set");
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
    console.error(
      "[webhook] Signature FAILED — ensure RAZORPAY_WEBHOOK_SECRET in .env.local " +
      "matches the secret saved in Razorpay dashboard → Settings → Webhooks"
    );
    return new Response("Invalid signature", { status: 400 });
  }

  const event          = JSON.parse(rawBody);
  const eventType:     string = event.event || "";
  const webhookEventId:string = event.id    || "";

  console.log(`[webhook] ✓ Event: ${eventType} | id: ${webhookEventId}`);

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

    console.log(
      `[webhook] paid — appId: ${applicationId} | linkId: ${rzpPaymentLinkId} | ` +
      `paymentId: ${rzpPaymentId} | amount: ${paidAmountPaise} paise`
    );

    if (!applicationId) {
      console.warn("[webhook] Cannot resolve applicationId — skipping");
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

      console.log(
        `[webhook] cross-verify: linkStatus=${linkDetails.status} | ` +
        `linkAmount=${linkDetails.amount} | expected=${feePaise}`
      );

      if (linkDetails.status !== "paid") {
        console.warn(`[webhook] Link status "${linkDetails.status}" ≠ "paid" — skipping`);
        return new Response("OK", { status: 200 });
      }
      if ((linkDetails.amount as number) !== feePaise) {
        console.warn(
          `[webhook] Amount mismatch: Razorpay=${linkDetails.amount} expected=${feePaise} ` +
          `— check FELLOWSHIP_FEE matches the amount the payment link was created with`
        );
        return new Response("OK", { status: 200 });
      }
    } catch (err: any) {
      console.error(
        "[webhook] Razorpay cross-verify FAILED:",
        err?.error?.description || err?.message || err
      );
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
          console.log(`[webhook] Duplicate event ${webhookEventId} — skipping`);
          return;
        }
        if (d.status === "paid") {
          console.log(`[webhook] App ${applicationId} already paid — skipping`);
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

    console.log(`[webhook] ✓ Firestore updated — app ${applicationId} marked as paid`);

    // suppress unused variable warning
    void paidAmountPaise;

    // ── Send emails (non-fatal, DB already committed) ────────────────────────
    const appSnap  = await appRef.get();
    const appData  = appSnap.data();
    const feeDisplay = `₹${(feePaise / 100).toFixed(0)}`;
    const adminEmail = process.env.ADMIN_EMAIL || "admin@dealschool.in";

    if (!appData?.email) {
      console.warn(`[webhook] No email on app ${applicationId} — skipping emails`);
    } else {
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
        .then(() => console.log(`[webhook] ✓ Receipt email → ${appData.email}`))
        .catch((err) => console.error("[webhook] Receipt email FAILED:", err?.message));

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
        .then(() => console.log(`[webhook] ✓ Admin notification → ${adminEmail}`))
        .catch((err) => console.error("[webhook] Admin email FAILED:", err?.message));
    }

  // ─── payment_link.expired ────────────────────────────────────────────────────
  } else if (eventType === "payment_link.expired") {
    const linkEntity = event.payload?.payment_link?.entity;
    if (!linkEntity) return new Response("OK", { status: 200 });

    const applicationId: string =
      linkEntity.notes?.applicationId || linkEntity.reference_id || "";
    if (!applicationId) return new Response("OK", { status: 200 });

    console.log(`[webhook] expired — appId: ${applicationId}`);

    await adminDb.collection("payments").doc(applicationId).set(
      { status: "expired", updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    await adminDb.collection("applications").doc(applicationId).set(
      { paymentStatus: "expired", updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log(`[webhook] ✓ Marked expired for app ${applicationId}`);

  } else {
    console.log(`[webhook] Unhandled event: ${eventType}`);
  }

  return new Response("OK", { status: 200 });
}
