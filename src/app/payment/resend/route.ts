import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { cancelPaymentLink } from "@/lib/cashfree";
import { createAndSendPaymentLink } from "@/lib/payment-service";
import { logInfo, logWarn, logError } from "@/lib/logger";

export const runtime = "nodejs";

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}

export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  logInfo("api/payment/resend", "POST received", { origin: origin ?? "none" });

  try { await verifyAdmin(request); }
  catch {
    logWarn("api/payment/resend", "Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  let applicationId: string;
  try {
    const body = await request.json();
    applicationId = body.applicationId;
    if (!applicationId || typeof applicationId !== "string") throw new Error();
  } catch {
    logWarn("api/payment/resend", "Missing or invalid applicationId in body");
    return NextResponse.json({ error: "applicationId is required" }, { status: 400, headers });
  }

  logInfo("api/payment/resend", "Resend requested", { applicationId });

  const appSnap = await adminDb.collection("applications").doc(applicationId).get();
  if (!appSnap.exists) {
    logWarn("api/payment/resend", "Application not found", { applicationId });
    return NextResponse.json({ error: "Application not found" }, { status: 404, headers });
  }

  const appData = appSnap.data()!;

  if (appData.paymentStatus === "paid") {
    logWarn("api/payment/resend", "Resend blocked — payment already completed", { applicationId });
    return NextResponse.json(
      { error: "Payment already completed — no resend needed." },
      { status: 422, headers }
    );
  }

  const paymentSnap = await adminDb.collection("payments").doc(applicationId).get();
  if (paymentSnap.exists && paymentSnap.data()!.status === "paid") {
    logWarn("api/payment/resend", "Resend blocked — payments doc shows paid", { applicationId });
    return NextResponse.json(
      { error: "Payment already completed — no resend needed." },
      { status: 422, headers }
    );
  }

  if (appData.status !== "accepted") {
    logWarn("api/payment/resend", "Resend blocked — application not in accepted status", { applicationId, status: appData.status });
    return NextResponse.json(
      { error: "Application must be in accepted status to resend payment link" },
      { status: 422, headers }
    );
  }

  const allowed = ["expired", "error", "failed", "link_sent", "processing"];
  if (appData.paymentStatus && !allowed.includes(appData.paymentStatus)) {
    logWarn("api/payment/resend", "Resend blocked — invalid paymentStatus for resend", { applicationId, paymentStatus: appData.paymentStatus });
    return NextResponse.json(
      { error: `Cannot resend — current payment status: ${appData.paymentStatus}` },
      { status: 422, headers }
    );
  }

  const oldLinkId: string | undefined = appData.paymentLinkId;
  if (oldLinkId && appData.paymentStatus !== "paid") {
    try {
      await cancelPaymentLink(oldLinkId);
      logInfo("api/payment/resend", "Old payment link cancelled", { applicationId, oldLinkId });
    } catch (err: unknown) {
      logWarn("api/payment/resend", `Could not cancel old link (may already be expired/cancelled) applicationId=${applicationId} oldLinkId=${oldLinkId}`);
    }
  }

  try {
    await createAndSendPaymentLink(applicationId);
    logInfo("api/payment/resend", "POST 200 — payment link resent", { applicationId });
    return NextResponse.json({ success: true }, { headers });
  } catch (err: unknown) {
    logError("api/payment/resend", `createAndSendPaymentLink threw unexpectedly applicationId=${applicationId}`, err);
    return NextResponse.json({ error: "Failed to resend payment link" }, { status: 500, headers });
  }
}
