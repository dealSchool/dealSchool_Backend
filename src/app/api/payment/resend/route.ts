import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { getRazorpay } from "@/lib/razorpay";
import { createAndSendPaymentLink } from "@/lib/payment-service";

export const runtime = "nodejs";

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}

export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  let applicationId: string;
  try {
    const body = await request.json();
    applicationId = body.applicationId;
    if (!applicationId || typeof applicationId !== "string") throw new Error();
  } catch {
    return NextResponse.json({ error: "applicationId is required" }, { status: 400, headers });
  }

  const appSnap = await adminDb.collection("applications").doc(applicationId).get();
  if (!appSnap.exists) {
    return NextResponse.json({ error: "Application not found" }, { status: 404, headers });
  }

  const appData = appSnap.data()!;

  // Block if already paid
  if (appData.paymentStatus === "paid") {
    return NextResponse.json(
      { error: "Payment already completed — no resend needed." },
      { status: 422, headers }
    );
  }

  // Double-check payments collection in case app doc is lagging
  const paymentSnap = await adminDb.collection("payments").doc(applicationId).get();
  if (paymentSnap.exists && paymentSnap.data()!.status === "paid") {
    return NextResponse.json(
      { error: "Payment already completed — no resend needed." },
      { status: 422, headers }
    );
  }

  if (appData.status !== "accepted") {
    return NextResponse.json(
      { error: "Application must be in accepted status to resend payment link" },
      { status: 422, headers }
    );
  }

  const allowed = ["expired", "error", "failed", "link_sent", "processing"];
  if (appData.paymentStatus && !allowed.includes(appData.paymentStatus)) {
    return NextResponse.json(
      { error: `Cannot resend — current payment status: ${appData.paymentStatus}` },
      { status: 422, headers }
    );
  }

  // Cancel the existing active Razorpay link so the applicant cannot pay the old one
  const oldLinkId: string | undefined = appData.rzpPaymentLinkId;
  if (oldLinkId && appData.paymentStatus !== "paid") {
    try {
      const rzp = getRazorpay();
      await rzp.paymentLink.cancel(oldLinkId);
      console.log(`[resend] ✓ Cancelled old payment link: ${oldLinkId}`);
    } catch (err: any) {
      // Non-fatal — link may already be expired or cancelled
      console.warn(
        `[resend] Could not cancel old link ${oldLinkId}:`,
        err?.error?.description || err?.message
      );
    }
  }

  await createAndSendPaymentLink(applicationId);

  return NextResponse.json({ success: true }, { headers });
}
