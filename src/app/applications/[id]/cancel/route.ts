import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { getRazorpay } from "@/lib/razorpay";
import { getCohortSettings } from "@/lib/cohort-settings";
import { computeRefundTier } from "@/lib/refund-service";
import { sendEmail } from "@/lib/mailer";
import { logInfo, logWarn, logError } from "@/lib/logger";
import {
  renderCancellationNoRefundEmail,
  renderRefundInitiatedEmail,
  renderRefundAdminNotification,
} from "@/lib/email-templates";

export const runtime = "nodejs";

const CANDIDATE_SENDER = "DealSchool <support@dealschool.in>";
const ADMIN_EMAIL      = process.env.ADMIN_EMAIL || "support@dealschool.in";

// A payment in either of these states cannot be cancelled again — the webhook
// (or a prior call) already owns the outcome. "refund_failed" is deliberately
// NOT here: it must stay retryable, or a Fellow whose refund failed once would
// have no way to ever get their money back via this endpoint.
const REFUND_TERMINAL_STATUSES = new Set(["refund_pending", "refunded"]);

// A payment doc in either of these states is eligible to be refunded now —
// "paid" for a first attempt, "refund_failed" for a retry after a prior failure.
const REFUNDABLE_PAYMENT_STATUSES = new Set(["paid", "refund_failed"]);

// ─── POST /applications/[id]/cancel — admin: cancel + auto-refund per policy ──
// Policy (Cancellation by the Fellow): 5+ days before cohort start -> 100%,
// 1-4 days before -> 50%, on/after cohort start -> no refund.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  logInfo("api/applications/[id]/cancel", "POST received", { id });

  try { await verifyAdmin(request); }
  catch {
    logWarn("api/applications/[id]/cancel", "Unauthorized cancel attempt", { id });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* body is optional */ }
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

  const appRef     = adminDb.collection("applications").doc(id);
  const paymentRef = adminDb.collection("payments").doc(id);
  const [appSnap, paymentSnap] = await Promise.all([appRef.get(), paymentRef.get()]);

  if (!appSnap.exists) {
    logWarn("api/applications/[id]/cancel", "Application not found", { id });
    return NextResponse.json({ error: "Application not found" }, { status: 404, headers });
  }

  const appData     = appSnap.data()!;
  const paymentData = paymentSnap.exists ? paymentSnap.data()! : null;
  const paymentStatus = paymentData?.status as string | undefined;

  // Already cancelled and settled (or never paid) — nothing left to do here.
  // A "cancelled" app whose last refund attempt FAILED is the one exception:
  // that must remain retryable, so it falls through instead of being blocked.
  if (appData.status === "cancelled" && paymentStatus !== "refund_failed") {
    return NextResponse.json({ error: "Application is already cancelled" }, { status: 409, headers });
  }

  const hasPaid =
    REFUNDABLE_PAYMENT_STATUSES.has(String(appData.paymentStatus)) &&
    REFUNDABLE_PAYMENT_STATUSES.has(String(paymentStatus));

  // ── Not paid (or refund already in flight/settled elsewhere): plain cancel ──
  if (!hasPaid) {
    if (paymentStatus && REFUND_TERMINAL_STATUSES.has(paymentStatus)) {
      return NextResponse.json(
        { error: `Refund already ${paymentStatus} for this application` },
        { status: 409, headers },
      );
    }

    const linkId = appData.rzpPaymentLinkId || paymentData?.rzpPaymentLinkId;
    if (linkId) {
      // Best-effort — an already-paid/expired/cancelled link errors harmlessly.
      getRazorpay().paymentLink.cancel(linkId).catch(() => {});
    }

    // Re-check status atomically so two concurrent calls can't both "succeed".
    let didCancel = false;
    await adminDb.runTransaction(async (t) => {
      const fresh = await t.get(appRef);
      const fd = fresh.data();
      if (!fd || fd.status === "cancelled") { didCancel = false; return; }
      t.update(appRef, {
        status:             "cancelled",
        cancelledAt:        FieldValue.serverTimestamp(),
        cancellationReason: reason || null,
        updatedAt:          FieldValue.serverTimestamp(),
      });
      didCancel = true;
    });

    if (!didCancel) {
      return NextResponse.json({ error: "Application is already cancelled" }, { status: 409, headers });
    }

    logInfo("api/applications/[id]/cancel", "Application cancelled (no payment on file)", { id });
    const updated = await appRef.get();
    return NextResponse.json(
      { success: true, refundPercent: 0, application: { id, ...serializeDoc(updated.data()!) } },
      { headers },
    );
  }

  // ── Paid (or retrying after a failed refund): determine the tier ────────────
  const { startDate } = await getCohortSettings();
  const { percent: refundPercent, daysBeforeStart } = computeRefundTier(startDate);
  const originalAmountPaise = paymentData!.amount as number;
  const refundAmountPaise   = Math.round((originalAmountPaise * refundPercent) / 100);
  const feeDisplay          = `₹${(originalAmountPaise / 100).toFixed(0)}`;
  const refundDisplay       = `₹${(refundAmountPaise / 100).toFixed(0)}`;

  logInfo("api/applications/[id]/cancel", "Cancellation with payment on file", {
    id,
    daysBeforeStart: String(daysBeforeStart),
    refundPercent:   String(refundPercent),
    refundAmountPaise: String(refundAmountPaise),
    isRetry: String(paymentStatus === "refund_failed"),
  });

  // ── 0% tier: cancel the application, payment itself is untouched ────────────
  if (refundPercent === 0) {
    let didCancel = false;
    await adminDb.runTransaction(async (t) => {
      const fresh = await t.get(appRef);
      const fd = fresh.data();
      if (!fd || (fd.status === "cancelled" && fd.paymentStatus !== "refund_failed")) {
        didCancel = false;
        return;
      }
      t.update(appRef, {
        status:             "cancelled",
        cancelledAt:        FieldValue.serverTimestamp(),
        cancellationReason: reason || null,
        refundPercent:      0,
        updatedAt:          FieldValue.serverTimestamp(),
      });
      didCancel = true;
    });

    if (!didCancel) {
      return NextResponse.json({ error: "Application is already cancelled" }, { status: 409, headers });
    }

    if (appData.email) {
      sendEmail({
        from:    CANDIDATE_SENDER,
        to:      String(appData.email),
        subject: "Your DealSchool Fellowship Cancellation",
        html:    renderCancellationNoRefundEmail({ fullName: String(appData.fullName || "Fellow"), feeDisplay }),
      }).catch((err) => logError("api/applications/[id]/cancel", `No-refund cancellation email FAILED id=${id}`, err));
    }

    const updated = await appRef.get();
    return NextResponse.json(
      { success: true, refundPercent: 0, application: { id, ...serializeDoc(updated.data()!) } },
      { headers },
    );
  }

  // ── 50% / 100% tier ──────────────────────────────────────────────────────────
  const rzpPaymentId = paymentData!.rzpPaymentId as string | undefined;
  if (!rzpPaymentId) {
    logError("api/applications/[id]/cancel", `Payment marked paid but rzpPaymentId is missing id=${id}`);
    return NextResponse.json(
      { error: "Cannot locate the Razorpay payment for this application" },
      { status: 500, headers },
    );
  }

  // Acquire an atomic lock BEFORE calling Razorpay — a Firestore transaction can
  // be retried internally, so an external, non-idempotent side effect (the
  // refund call) must never live inside one. Locking first, outside any
  // transaction retry, is what actually prevents two concurrent requests from
  // both refunding this payment.
  let lockAcquired = false;
  await adminDb.runTransaction(async (t) => {
    const fresh = await t.get(paymentRef);
    const fp = fresh.data();
    if (!fp || !REFUNDABLE_PAYMENT_STATUSES.has(String(fp.status))) {
      lockAcquired = false;
      return;
    }
    t.update(paymentRef, { status: "refund_pending", updatedAt: FieldValue.serverTimestamp() });
    lockAcquired = true;
  });

  if (!lockAcquired) {
    logWarn("api/applications/[id]/cancel", "Lock not acquired — refund already in flight/settled", { id });
    return NextResponse.json(
      { error: "A refund is already in progress or has already completed for this application" },
      { status: 409, headers },
    );
  }

  let refund;
  try {
    refund = await getRazorpay().payments.refund(rzpPaymentId, {
      amount: refundAmountPaise,
      speed:  "normal",
      notes:  { applicationId: id, reason: "cancellation", refundPercent: String(refundPercent) },
    });
  } catch (err: any) {
    logError("api/applications/[id]/cancel", `Razorpay refund FAILED id=${id} rzpPaymentId=${rzpPaymentId}`, err);
    // Release the lock so this can be retried — restore the pre-lock status.
    await paymentRef.update({ status: paymentStatus, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    return NextResponse.json(
      { error: "Failed to initiate refund with Razorpay. Application status was not changed." },
      { status: 502, headers },
    );
  }

  // ── Finalize now that Razorpay has accepted the refund and the lock is ours ──
  await adminDb.runTransaction(async (t) => {
    t.update(appRef, {
      status:             "cancelled",
      paymentStatus:      "refund_pending",
      cancelledAt:        FieldValue.serverTimestamp(),
      cancellationReason: reason || null,
      refundPercent,
      updatedAt:          FieldValue.serverTimestamp(),
    });
    t.update(paymentRef, {
      status:            "refund_pending",
      rzpRefundId:       refund.id,
      refundAmount:      refundAmountPaise,
      refundPercent,
      refundInitiatedAt: FieldValue.serverTimestamp(),
      updatedAt:         FieldValue.serverTimestamp(),
    });
  });

  logInfo("api/applications/[id]/cancel", "Refund initiated with Razorpay", {
    id, rzpRefundId: refund.id, refundAmountPaise: String(refundAmountPaise),
  });

  // ── Emails (non-fatal, DB already committed) ─────────────────────────────────
  if (appData.email) {
    sendEmail({
      from:    CANDIDATE_SENDER,
      to:      String(appData.email),
      subject: "Your DealSchool Fellowship Refund Has Been Initiated",
      html:    renderRefundInitiatedEmail({
        fullName:      String(appData.fullName || "Fellow"),
        feeDisplay,
        refundDisplay,
        refundPercent,
      }),
    }).catch((err) => logError("api/applications/[id]/cancel", `Refund-initiated email FAILED id=${id}`, err));
  }

  sendEmail({
    from:    CANDIDATE_SENDER,
    to:      ADMIN_EMAIL,
    subject: `[Refund Initiated] ${String(appData.fullName || "Fellow")}: ${refundDisplay} (${refundPercent}%)`,
    html:    renderRefundAdminNotification({
      applicantName:  String(appData.fullName || "Fellow"),
      applicantEmail: String(appData.email || ""),
      applicationId:  id,
      status:         "initiated",
      refundDisplay,
      refundPercent,
      rzpRefundId:    refund.id,
    }),
  }).catch((err) => logError("api/applications/[id]/cancel", `Refund admin notification FAILED id=${id}`, err));

  const updated = await appRef.get();
  return NextResponse.json(
    {
      success: true,
      refundPercent,
      refundAmountPaise,
      rzpRefundId: refund.id,
      application: { id, ...serializeDoc(updated.data()!) },
    },
    { headers },
  );
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
