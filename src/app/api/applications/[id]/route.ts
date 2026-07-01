import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { createRazorpayPaymentLink } from "@/lib/payment-service";
import { getRazorpay } from "@/lib/razorpay";
import { sendEmail } from "@/lib/mailer";
import { logInfo, logWarn, logError } from "@/lib/logger";
import {
  renderAppUnderReview,
  renderInterviewInvited,
  renderAppDeclined,
  renderPaymentLinkEmail,
} from "@/lib/email-templates";

export const runtime = "nodejs";

const CANDIDATE_SENDER = "DealSchool <support@dealschool.in>";

// Fields that must never be set directly by an admin PATCH — they are owned
// exclusively by the payment flow and the Razorpay webhook.
const PAYMENT_PROTECTED = new Set([
  "paymentStatus",
  "rzpPaymentId",
  "rzpPaymentLinkId",
  "rzpPaymentLinkUrl",
  "paidAt",
  "paymentLinkSentAt",
]);

// ─── PATCH /api/applications/[id] — admin: update status ─────────────────────
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

  const updatePayload: Record<string, any> = {
    ...body,
    updatedAt: FieldValue.serverTimestamp(),
  };
  delete updatePayload.id;
  delete updatePayload.createdAt;

  // Strip payment-sensitive fields — prevents an admin from manually forging
  // a paid status without an actual Razorpay transaction.
  for (const field of PAYMENT_PROTECTED) {
    delete updatePayload[field];
  }

  // ── "accepted": Razorpay first, then atomic Firestore write ──────────────────
  if (newStatus === "accepted" && newStatus !== prevStatus) {
    // Step 1 — create Razorpay link (throws on failure → nothing written to DB)
    let link: Awaited<ReturnType<typeof createRazorpayPaymentLink>>;
    try {
      link = await createRazorpayPaymentLink(id, prevData);
    } catch (err: any) {
      console.error("[accept] Razorpay error:", err?.error || err?.message);
      return NextResponse.json(
        { error: "Failed to create payment link. Application status was not updated." },
        { status: 502, headers },
      );
    }

    // Step 2 — use a transaction (not batch) so we can re-check status atomically.
    // Guards against two concurrent "accept" requests both creating Razorpay links.
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
          rzpPaymentLinkId:  link.linkId,
          paymentLinkSentAt: FieldValue.serverTimestamp(),
        });
        t.set(adminDb.collection("payments").doc(id), {
          applicationId:       id,
          applicantName:       prevData.fullName     || "",
          applicantEmail:      prevData.email        || "",
          applicantPhone:      prevData.mobileNumber || "",
          amount:              link.feePaise,
          currency:            "INR",
          rzpPaymentLinkId:    link.linkId,
          rzpPaymentLinkUrl:   link.linkUrl,
          status:              "link_created",
          expiresAt:           link.expiresAt,
          processedWebhookIds: [],
          createdAt:           FieldValue.serverTimestamp(),
          updatedAt:           FieldValue.serverTimestamp(),
        });
      });
    } catch (err: any) {
      console.error("[accept] Transaction error:", err?.message);
      // Cancel the orphaned Razorpay link since we can't store it
      getRazorpay().paymentLink.cancel(link.linkId).catch(() => {});
      return NextResponse.json(
        { error: "Failed to update database. Please try again." },
        { status: 500, headers },
      );
    }

    if (alreadyAccepted) {
      // Cancel the orphaned Razorpay link created by this request
      getRazorpay().paymentLink.cancel(link.linkId).catch(() => {});
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
      subject: "Your DealSchool Fellowship Offer — Action Required",
      html:    renderPaymentLinkEmail({
        fullName:   String(prevData.fullName || ""),
        linkUrl:    link.linkUrl,
        feeDisplay,
      }),
    }).then(() => {
      logInfo("api/applications/[id]", "Payment-link email sent OK", { id, applicantEmail: prevData.email });
      return adminDb.collection("payments").doc(id).update({ emailSentAt: FieldValue.serverTimestamp() });
    }).catch((err) => logError("api/applications/[id]", `Payment-link email FAILED id=${id} applicantEmail=${prevData.email}`, err));

    const updated = await docRef.get();
    logInfo("api/applications/[id]", "PATCH 200 — application accepted", { id });
    return NextResponse.json(
      { success: true, application: { id, ...serializeDoc(updated.data()!) } },
      { headers },
    );
  }

  // ── All other status changes ──────────────────────────────────────────────────
  await docRef.update(updatePayload);
  logInfo("api/applications/[id]", "Firestore updated", { id, newStatus, prevStatus });

  if (newStatus && newStatus !== prevStatus) {
    const emailMap: Record<string, { subject: string; html: string }> = {
      under_review: {
        subject: "Your DealSchool Application is Now Under Review",
        html:    renderAppUnderReview({ fullName: String(prevData.fullName || "Applicant") }),
      },
      interview_invited: {
        subject: "You've Been Invited to Interview — DealSchool Fellowship",
        html:    renderInterviewInvited({ fullName: String(prevData.fullName || "Applicant") }),
      },
      declined: {
        subject: "DealSchool Fellowship Application — Update",
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
  }

  const responsePayload = { ...updatePayload, updatedAt: new Date().toISOString() };
  const merged = serializeDoc({ ...prevData, ...responsePayload });
  logInfo("api/applications/[id]", "PATCH 200 completed", { id, newStatus });
  return NextResponse.json(
    { success: true, application: { id, ...merged } },
    { headers },
  );
}

// ─── DELETE /api/applications/[id] — admin: delete ───────────────────────────
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
  const hasPaid     =
    appData.paymentStatus === "paid" ||
    (paymentData?.status === "paid");

  // If payment was completed and admin hasn't confirmed, ask for confirmation
  if (hasPaid && !confirmed) {
    const feePaise   = paymentData?.amount ?? parseInt(process.env.FELLOWSHIP_FEE || "100", 10) * 100;
    const feeDisplay = `₹${(feePaise / 100).toFixed(0)}`;
    return NextResponse.json(
      {
        requiresConfirmation: true,
        applicantName:        String(appData.fullName || "this applicant"),
        applicantEmail:       String(appData.email    || ""),
        feeDisplay,
        rzpPaymentId:         String(paymentData?.rzpPaymentId || appData.rzpPaymentId || ""),
        message:
          `${String(appData.fullName || "This applicant")} has already paid the fellowship fee of ` +
          `${feeDisplay}. Deleting this record will not trigger a refund. ` +
          `You must process the refund manually via the Razorpay dashboard.`,
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

  console.log(
    `[delete] Application ${id} deleted by admin` +
    (hasPaid ? ` — payment of ${paymentData?.amount} paise existed (confirmed delete)` : "")
  );

  return NextResponse.json({ success: true }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
