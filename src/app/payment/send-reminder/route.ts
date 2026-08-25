import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { sendWhatsAppTemplate, toWhatsAppId } from "@/lib/cheerio-whatsapp";
import { TEMPLATE_NAME, bodyParams } from "@/lib/payment-reminder";
import { logInfo, logWarn, logError } from "@/lib/logger";

export const runtime = "nodejs";

// Manual, on-demand version of the "payment_reminder_new" WhatsApp message
// that /cron/payment-reminder sends automatically 24h after an unpaid link —
// lets an admin fire the same message immediately from the dashboard instead
// of waiting on the cron threshold. Deliberately does NOT touch
// paymentReminderSent/paymentReminderSentAt (see payment-reminder.ts) — those
// gate the cron job's own once-per-stage logic, and this button must not
// change when/whether that automatic reminder still fires later. Instead it
// records its own separate manualPaymentReminderSentAt/By fields, purely for
// admin-side audit visibility.

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}

export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  logInfo("api/payment/send-reminder", "POST received", { origin: origin ?? "none" });

  let admin: { uid: string; email: string };
  try { admin = await verifyAdmin(request); }
  catch {
    logWarn("api/payment/send-reminder", "Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  let applicationId: string;
  try {
    const body = await request.json();
    applicationId = body.applicationId;
    if (!applicationId || typeof applicationId !== "string") throw new Error();
  } catch {
    logWarn("api/payment/send-reminder", "Missing or invalid applicationId in body");
    return NextResponse.json({ error: "applicationId is required" }, { status: 400, headers });
  }

  logInfo("api/payment/send-reminder", "Manual payment reminder requested", { applicationId, admin: admin.email });

  const appSnap = await adminDb.collection("applications").doc(applicationId).get();
  if (!appSnap.exists) {
    logWarn("api/payment/send-reminder", "Application not found", { applicationId });
    return NextResponse.json({ error: "Application not found" }, { status: 404, headers });
  }
  const appData = appSnap.data()!;

  if (appData.status !== "accepted") {
    logWarn("api/payment/send-reminder", "Blocked — application not in accepted status", { applicationId, status: appData.status });
    return NextResponse.json(
      { error: "Application must be in accepted status to send a payment reminder" },
      { status: 422, headers }
    );
  }

  if (appData.paymentStatus === "paid") {
    logWarn("api/payment/send-reminder", "Blocked — payment already completed", { applicationId });
    return NextResponse.json(
      { error: "Payment already completed — no reminder needed." },
      { status: 422, headers }
    );
  }

  const mobileNumber = appData.mobileNumber;
  if (!mobileNumber) {
    logWarn("api/payment/send-reminder", "Blocked — applicant has no mobileNumber", { applicationId });
    return NextResponse.json({ error: "Applicant has no mobile number on file" }, { status: 422, headers });
  }

  const paymentSnap = await adminDb.collection("payments").doc(applicationId).get();
  const paymentLinkUrl = paymentSnap.data()?.paymentLinkUrl;
  if (!paymentLinkUrl) {
    logWarn("api/payment/send-reminder", "Blocked — no paymentLinkUrl found", { applicationId });
    return NextResponse.json(
      { error: "No payment link found for this applicant — create/send one first" },
      { status: 422, headers }
    );
  }

  const fullName = appData.fullName || "there";

  try {
    await sendWhatsAppTemplate({
      to: toWhatsAppId(String(mobileNumber)),
      templateName: TEMPLATE_NAME,
      bodyParams: bodyParams(String(fullName)),
      buttonUrl: String(paymentLinkUrl),
    });
    // Audit-only — never read by the cron job's own eligibility query, so
    // this can't change when/whether the automatic reminder still fires.
    await appSnap.ref.update({
      manualPaymentReminderSentAt: FieldValue.serverTimestamp(),
      manualPaymentReminderSentBy: admin.email,
    });
    logInfo("api/payment/send-reminder", "POST 200 — manual payment reminder sent", { applicationId, admin: admin.email });
    return NextResponse.json({ success: true }, { headers });
  } catch (err: unknown) {
    logError("api/payment/send-reminder", `sendWhatsAppTemplate FAILED applicationId=${applicationId}`, err);
    return NextResponse.json({ error: "Failed to send payment reminder" }, { status: 500, headers });
  }
}
