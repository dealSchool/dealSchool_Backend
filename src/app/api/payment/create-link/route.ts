import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { createAndSendPaymentLink } from "@/lib/payment-service";
import { adminDb } from "@/lib/firebase-admin";

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

  // Delegates all Razorpay + Firestore + email logic to payment-service
  await createAndSendPaymentLink(applicationId);

  return NextResponse.json({ success: true }, { headers });
}
