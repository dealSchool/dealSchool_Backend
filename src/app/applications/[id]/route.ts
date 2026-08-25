import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { createCashfreePaymentLink } from "@/lib/payment-service";
import { cancelPaymentLink } from "@/lib/cashfree";
import { sendEmail } from "@/lib/mailer";
import { sendWhatsAppTemplate, toWhatsAppId } from "@/lib/cheerio-whatsapp";
import { sendCheerioEmailTemplate } from "@/lib/cheerio-email-templates";
import { logInfo, logWarn, logError } from "@/lib/logger";
import {
  renderAppUnderReview,
  renderInterviewInvited,
  renderAppDeclined,
  renderPaymentLinkEmail,
} from "@/lib/email-templates";
import { invalidateApplicationsListCache } from "@/lib/applications-cache";

export const runtime = "nodejs";

const CANDIDATE_SENDER = "DealSchool <support@dealschool.in>";

// Fields that must never be set directly by an admin PATCH — they are owned
// exclusively by the payment flow and the Cashfree webhook.
const PAYMENT_PROTECTED = new Set([
  "paymentStatus",
  "paymentOrderId",
  "paymentLinkId",
  "paymentLinkUrl",
  "paidAt",
  "paymentLinkSentAt",
]);

// ─── GET /applications/[id] — admin: full detail view ─────────────────────────
// Returns every field the applicant submitted plus payment/refund metadata from
// the "payments" collection, so the admin portal can render a complete detail
// view without piecing it together from the paginated list response.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  const [appSnap, paymentSnap] = await Promise.all([
    adminDb.collection("applications").doc(id).get(),
    adminDb.collection("payments").doc(id).get(),
  ]);

  if (!appSnap.exists) {
    return NextResponse.json({ error: "Application not found" }, { status: 404, headers });
  }

  const application = { id: appSnap.id, ...serializeDoc(appSnap.data()!) };
  const payment      = paymentSnap.exists ? { id: paymentSnap.id, ...serializeDoc(paymentSnap.data()!) } : null;

  return NextResponse.json({ application, payment }, { headers });
}

// ─── PATCH /applications/[id] — admin: update status ──────────────────────────
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  logInfo("api/applications/[id]", "PATCH received", { id, origin: origin ?? "none" });

  try { await verifyAdmin(request); }
  catch {
    logWarn("api/applications/[id]", "Unauthorized PATCH attempt", { id });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  let body: any;
  try { body = await request.json(); }
  catch {
    logWarn("api/applications/[id]", "Invalid JSON body", { id });
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  const docRef = adminDb.collection("applications").doc(id);
  const snap   = await docRef.get();

  if (!snap.exists) {
    logWarn("api/applications/[id]", "Application not found", { id });
    return NextResponse.json({ error: "Application not found" }, { status: 404, headers });
  }

  const prevData   = snap.data()!;
  const prevStatus = prevData.status;
  const newStatus  = body.status;
  logInfo("api/applications/[id]", "Status change requested", { id, prevStatus, newStatus, applicantEmail: prevData.email ?? "none" });

  // "cancelled" carries refund-policy side effects (Cashfree refund, refund
  // emails) that only POST /applications/[id]/cancel knows how to run —
  // block it here so it can never be set as a bare status flip.
  if (newStatus === "cancelled") {
    logWarn("api/applications/[id]", "Rejected direct status=cancelled PATCH — use /cancel endpoint", { id });
    return NextResponse.json(
      { error: "Use POST /applications/[id]/cancel to cancel an application — it also processes any refund owed." },
      { status: 400, headers },
    );
  }

  const updatePayload: Record<string, any> = {
    ...body,
    updatedAt: FieldValue.serverTimestamp(),
  };
  delete updatePayload.id;
  delete updatePayload.createdAt;

  // Strip payment-sensitive fields — prevents an admin from manually forging
  // a paid status without an actual Cashfree transaction.
  for (const field of PAYMENT_PROTECTED) {
    delete updatePayload[field];
  }

  // Track when the CURRENT status began — cron jobs (e.g. the under_review
  // audit-followup reminder) key off this rather than updatedAt, which also
  // changes for edits that aren't a status transition.
  if (newStatus && newStatus !== prevStatus) {
    updatePayload.statusChangedAt = FieldValue.serverTimestamp();
    // Re-entering under_review restarts the audit-followup timer.
    if (newStatus === "under_review") {
      updatePayload.auditFollowupSent = false;
    }
    // Re-entering interview_invited restarts the interview-shortlisted-followup timer.
    if (newStatus === "interview_invited") {
      updatePayload.interviewReminderSent = false;
    }
  }

  // ── "accepted": Cashfree first, then atomic Firestore write ──────────────────
  if (newStatus === "accepted" && newStatus !== prevStatus) {
    // Step 1 — create Cashfree link (throws on failure → nothing written to DB)
    let link: Awaited<ReturnType<typeof createCashfreePaymentLink>>;
    try {
      link = await createCashfreePaymentLink(id, prevData);
    } catch (err: any) {
      console.error("[accept] Cashfree error:", err?.message);
      return NextResponse.json(
        { error: "Failed to create payment link. Application status was not updated." },
        { status: 502, headers },
      );
    }

    // Step 2 — use a transaction (not batch) so we can re-check status atomically.
    // Guards against two concurrent "accept" requests both creating Cashfree links.
    let alreadyAccepted = false;
    try {
      await adminDb.runTransaction(async (t) => {
        const current = await t.get(docRef);
        if (!current.exists) throw new Error("Application not found");

        // If another concurrent request already accepted this application,
        // abort — we'll cancel the orphaned link we just created.
        if (current.data()!.status === "accepted") {
          alreadyAccepted = true;
          return;
        }

        t.update(docRef, {
          ...updatePayload,
          paymentStatus:     "link_sent",
          paymentLinkId:     link.linkId,
          paymentLinkSentAt: FieldValue.serverTimestamp(),
          // Reset so a re-accept (e.g. after a prior cancellation) gets its own reminder timer.
          paymentReminderSent: false,
        });
        t.set(adminDb.collection("payments").doc(id), {
          applicationId:       id,
          applicantName:       prevData.fullName     || "",
          applicantEmail:      prevData.email        || "",
          applicantPhone:      prevData.mobileNumber || "",
          amount:              link.feePaise,
          currency:            "INR",
          paymentLinkId:       link.linkId,
          paymentLinkUrl:      link.linkUrl,
          status:              "link_created",
          expiresAt:           link.expiresAt,
          processedWebhookIds: [],
          createdAt:           FieldValue.serverTimestamp(),
          updatedAt:           FieldValue.serverTimestamp(),
        });
      });
    } catch (err: any) {
      console.error("[accept] Transaction error:", err?.message);
      // Cancel the orphaned Cashfree link since we can't store it
      cancelPaymentLink(link.linkId).catch(() => {});
      return NextResponse.json(
        { error: "Failed to update database. Please try again." },
        { status: 500, headers },
      );
    }

    if (alreadyAccepted) {
      // Cancel the orphaned Cashfree link created by this request
      cancelPaymentLink(link.linkId).catch(() => {});
      return NextResponse.json(
        { error: "Application was already accepted in a concurrent session." },
        { status: 409, headers },
      );
    }

    // Step 3 — send payment-link email (non-fatal; DB already committed)
    const feeDisplay = `₹${(link.feePaise / 100).toFixed(0)}`;
    logInfo("api/applications/[id]", "Sending payment-link email", { id, applicantEmail: prevData.email, feeDisplay });
    sendEmail({
      from:    CANDIDATE_SENDER,
      to:      String(prevData.email),
      subject: "Your DealSchool Fellowship Offer: Action Required",
      html:    renderPaymentLinkEmail({
        fullName:   String(prevData.fullName || ""),
        linkUrl:    link.linkUrl,
        feeDisplay,
      }),
    }).then(() => {
      logInfo("api/applications/[id]", "Payment-link email sent OK", { id, applicantEmail: prevData.email });
      return adminDb.collection("payments").doc(id).update({ emailSentAt: FieldValue.serverTimestamp() });
    }).catch((err) => logError("api/applications/[id]", `Payment-link email FAILED id=${id} applicantEmail=${prevData.email}`, err));

    // Step 4 — send payment-link WhatsApp (non-fatal; DB already committed)
    if (!prevData.mobileNumber) {
      logWarn("api/applications/[id]", "Applicant has no mobileNumber — payment_link_new WhatsApp skipped", { id });
    } else {
      sendWhatsAppTemplate({
        to: toWhatsAppId(String(prevData.mobileNumber)),
        templateName: "payment_link_new",
        bodyParams: [
          String(prevData.fullName || "there"),
          "You've been selected for the upcoming DealSchool Venture Capital Fellowship cohort.",
          "We've just shared the next steps, along with your payment link, on your email. Please have a look whenever you get a chance.",
        ],
        buttonUrl: link.linkUrl,
      })
        .then(() => logInfo("api/applications/[id]", "payment_link_new WhatsApp sent OK", { id }))
        .catch((err) => logError("api/applications/[id]", `payment_link_new WhatsApp FAILED id=${id}`, err));
    }

    invalidateApplicationsListCache();
    const updated = await docRef.get();
    logInfo("api/applications/[id]", "PATCH 200 — application accepted", { id });
    return NextResponse.json(
      { success: true, application: { id, ...serializeDoc(updated.data()!) } },
      { headers },
    );
  }

  // ── All other status changes ──────────────────────────────────────────────────
  await docRef.update(updatePayload);
  invalidateApplicationsListCache();
  logInfo("api/applications/[id]", "Firestore updated", { id, newStatus, prevStatus });

  if (newStatus && newStatus !== prevStatus) {
    const emailMap: Record<string, { subject: string; html: string }> = {
      under_review: {
        subject: "Your DealSchool Application is Now Under Review",
        html:    renderAppUnderReview({ fullName: String(prevData.fullName || "Applicant") }),
      },
      interview_invited: {
        subject: "You've Been Invited to Interview for the DealSchool Fellowship",
        html:    renderInterviewInvited({ fullName: String(prevData.fullName || "Applicant") }),
      },
      declined: {
        subject: "An Update on Your DealSchool Fellowship Application",
        html:    renderAppDeclined({ fullName: String(prevData.fullName || "Applicant") }),
      },
    };
    const tpl = emailMap[newStatus];

    if (!tpl) {
      logInfo("api/applications/[id]", "No email template for this status — skipping email", { id, newStatus });
    } else if (!prevData.email) {
      logWarn("api/applications/[id]", "Applicant has no email address — status-change email skipped", { id, newStatus });
    } else {
      logInfo("api/applications/[id]", "Sending status-change email", { id, newStatus, applicantEmail: prevData.email, subject: tpl.subject });
      sendEmail({ from: CANDIDATE_SENDER, to: String(prevData.email), ...tpl })
        .then(() => logInfo("api/applications/[id]", "Status-change email sent OK", { id, newStatus, applicantEmail: prevData.email }))
        .catch((err) => logError("api/applications/[id]", `Status-change email FAILED — applicant did NOT receive notification | id=${id} newStatus=${newStatus} applicantEmail=${prevData.email}`, err));
    }

    // "interview_completed" is admin-marked (no email template) — fires the
    // after_interview WhatsApp template immediately, not via a delayed cron.
    if (newStatus === "interview_completed") {
      if (!prevData.mobileNumber) {
        logWarn("api/applications/[id]", "Applicant has no mobileNumber — after_interview WhatsApp skipped", { id });
      } else {
        sendWhatsAppTemplate({
          to: toWhatsAppId(String(prevData.mobileNumber)),
          templateName: "after_interview",
          bodyParams: [
            String(prevData.fullName || "there"),
            "interview with us.",
            "We're currently reviewing all shortlisted candidates and will share the outcome with you as soon as the process is complete.",
            "We appreciate your patience, and we'll be in touch soon.",
          ],
        })
          .then(() => logInfo("api/applications/[id]", "after_interview WhatsApp sent OK", { id }))
          .catch((err) => logError("api/applications/[id]", `after_interview WhatsApp FAILED id=${id}`, err));
      }

      // Same after_interview send, on the email channel — independent of the
      // WhatsApp call above (its own fire-and-forget, doesn't block/depend on it).
      if (!prevData.email) {
        logWarn("api/applications/[id]", "Applicant has no email — after_interview email skipped", { id });
      } else {
        sendCheerioEmailTemplate("after_interview", String(prevData.email))
          .then(() => logInfo("api/applications/[id]", "after_interview email sent OK", { id }))
          .catch((err) => logError("api/applications/[id]", `after_interview email FAILED id=${id}`, err));
      }
    }
  }

  const responsePayload = {
    ...updatePayload,
    updatedAt: new Date().toISOString(),
    // FieldValue.serverTimestamp() is a write-only sentinel — it doesn't
    // serialize to a real value, so give the response a real Date same as
    // updatedAt above (Firestore itself already has the correct value).
    ...(updatePayload.statusChangedAt && { statusChangedAt: new Date().toISOString() }),
  };
  const merged = serializeDoc({ ...prevData, ...responsePayload });
  logInfo("api/applications/[id]", "PATCH 200 completed", { id, newStatus });
  return NextResponse.json(
    { success: true, application: { id, ...merged } },
    { headers },
  );
}

// ─── DELETE /applications/[id] — admin: delete ────────────────────────────────
// If the applicant has already paid, the endpoint returns 409 with
// { requiresConfirmation: true } so the frontend can show a warning modal.
// Re-call with ?confirmed=true to force-delete after the admin confirms.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  const confirmed = new URL(request.url).searchParams.get("confirmed") === "true";

  const [appSnap, paymentSnap] = await Promise.all([
    adminDb.collection("applications").doc(id).get(),
    adminDb.collection("payments").doc(id).get(),
  ]);

  if (!appSnap.exists) {
    return NextResponse.json({ error: "Application not found" }, { status: 404, headers });
  }

  const appData     = appSnap.data()!;
  const paymentData = paymentSnap.exists ? paymentSnap.data()! : null;

  // Any status that means money moved (or is moving) — not just "currently paid".
  // Deleting the record mid-refund or post-refund would destroy the only audit
  // trail of that transaction, so it needs the same confirmation gate.
  const PAYMENT_HISTORY_STATUSES = new Set(["paid", "refund_pending", "refunded", "refund_failed"]);
  const hasPaid =
    PAYMENT_HISTORY_STATUSES.has(String(appData.paymentStatus)) ||
    PAYMENT_HISTORY_STATUSES.has(String(paymentData?.status));

  // If payment was completed (or a refund is/was in progress) and admin hasn't
  // confirmed, ask for confirmation
  if (hasPaid && !confirmed) {
    const feePaise   = paymentData?.amount ?? parseInt(process.env.FELLOWSHIP_FEE || "100", 10) * 100;
    const feeDisplay = `₹${(feePaise / 100).toFixed(0)}`;
    const refundState = paymentData?.status && paymentData.status !== "paid" ? paymentData.status : null;
    return NextResponse.json(
      {
        requiresConfirmation: true,
        applicantName:        String(appData.fullName || "this applicant"),
        applicantEmail:       String(appData.email    || ""),
        feeDisplay,
        paymentOrderId:       String(paymentData?.paymentOrderId || appData.paymentOrderId || ""),
        refundState,
        message: refundState
          ? `${String(appData.fullName || "This applicant")} has a refund in status "${refundState}" for their ` +
            `${feeDisplay} fellowship fee. Deleting this record will destroy that history — it will not affect ` +
            `the actual Cashfree transaction.`
          : `${String(appData.fullName || "This applicant")} has already paid the fellowship fee of ` +
            `${feeDisplay}. Deleting this record will not trigger a refund. ` +
            `You must process the refund manually via the Cashfree dashboard, or use ` +
            `POST /applications/${id}/cancel instead of deleting.`,
      },
      { status: 409, headers }
    );
  }

  // Delete application and payments docs atomically via batch
  const batch = adminDb.batch();
  batch.delete(adminDb.collection("applications").doc(id));
  if (paymentSnap.exists) {
    batch.delete(adminDb.collection("payments").doc(id));
  }
  await batch.commit();
  invalidateApplicationsListCache();

  console.log(
    `[delete] Application ${id} deleted by admin` +
    (hasPaid ? ` — payment of ${paymentData?.amount} paise existed (confirmed delete)` : "")
  );

  return NextResponse.json({ success: true }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
