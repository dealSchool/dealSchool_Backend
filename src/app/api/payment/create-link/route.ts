import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { createAndSendPaymentLink } from "@/lib/payment-service";
import { adminDb } from "@/lib/firebase-admin";
import { logInfo, logWarn, logError } from "@/lib/logger";

export const runtime = "nodejs";

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}

export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  logInfo("api/payment/create-link", "POST received", { origin: origin ?? "none" });

  try { await verifyAdmin(request); }
  catch {
    logWarn("api/payment/create-link", "Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  let applicationId: string;
  try {
    const body = await request.json();
    applicationId = body.applicationId;
    if (!applicationId || typeof applicationId !== "string") throw new Error();
  } catch {
    logWarn("api/payment/create-link", "Missing or invalid applicationId in body");
    return NextResponse.json({ error: "applicationId is required" }, { status: 400, headers });
  }

  const appSnap = await adminDb.collection("applications").doc(applicationId).get();
  if (!appSnap.exists) {
    logWarn("api/payment/create-link", "Application not found", { applicationId });
    return NextResponse.json({ error: "Application not found" }, { status: 404, headers });
  }

  logInfo("api/payment/create-link", "Creating and sending payment link", { applicationId });
  try {
    await createAndSendPaymentLink(applicationId);
    logInfo("api/payment/create-link", "POST 200 — payment link created and sent", { applicationId });
    return NextResponse.json({ success: true }, { headers });
  } catch (err: unknown) {
    logError("api/payment/create-link", `createAndSendPaymentLink threw unexpectedly applicationId=${applicationId}`, err);
    return NextResponse.json({ error: "Failed to create payment link" }, { status: 500, headers });
  }
}
