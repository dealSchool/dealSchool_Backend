import { NextRequest, NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { sanitizeHeader } from "@/lib/validate";

export const runtime = "nodejs";

// ─── POST /applications/draft/verify — public: verify OTP, return draft data ──
// Body: { mobileNumber, otp }
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const ip      = getClientIp(request);

  const ipRl = await checkRateLimit(`apply-draft-verify-ip:${ip}`, 30, 15 * 60 * 1000);
  if (!ipRl.allowed) {
    logWarn("api/applications/draft/verify", "IP rate limited", { ip });
    return NextResponse.json(
      { error: "Too many requests. Please wait before trying again." },
      { status: 429, headers: { ...headers, "Retry-After": String(Math.ceil(ipRl.retryAfterMs / 1000)) } }
    );
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  const mobileNumber = typeof body.mobileNumber === "string" ? sanitizeHeader(body.mobileNumber) : "";
  const otp          = body.otp;
  if (!mobileNumber || !otp) {
    return NextResponse.json({ error: "mobileNumber and otp are required" }, { status: 400, headers });
  }

  // Caps OTP brute-force attempts per phone number (6-digit code = 1,000,000 combos).
  const otpRl = await checkRateLimit(`apply-draft-verify-phone:${mobileNumber}`, 5, 15 * 60 * 1000);
  if (!otpRl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait before trying again." },
      { status: 429, headers: { ...headers, "Retry-After": String(Math.ceil(otpRl.retryAfterMs / 1000)) } }
    );
  }

  try {
    const draftSnap = await adminDb
      .collection("applicationDrafts")
      .where("mobileNumber", "==", mobileNumber)
      .where("status", "==", "in_progress")
      .limit(1)
      .get();

    if (draftSnap.empty) {
      return NextResponse.json({ error: "No saved application found for this number" }, { status: 404, headers });
    }

    const draftDoc = draftSnap.docs[0];
    const otpRef   = adminDb.collection("draftOtps").doc(draftDoc.id);
    const otpSnap  = await otpRef.get();

    if (!otpSnap.exists) {
      return NextResponse.json({ error: "No OTP found. Please request a new one." }, { status: 400, headers });
    }

    const otpData = otpSnap.data()!;

    if (otpData.used) {
      return NextResponse.json({ error: "OTP already used. Please request a new one." }, { status: 400, headers });
    }
    if ((otpData.expiresAt as Timestamp).seconds < Timestamp.now().seconds) {
      return NextResponse.json({ error: "OTP has expired. Please request a new one." }, { status: 400, headers });
    }
    if (otpData.otpCode !== String(otp)) {
      logWarn("api/applications/draft/verify", "Invalid OTP submitted", { draftId: draftDoc.id });
      return NextResponse.json({ error: "Invalid OTP." }, { status: 400, headers });
    }

    await otpRef.update({ used: true, usedAt: FieldValue.serverTimestamp() });

    const draft = draftDoc.data();
    logInfo("api/applications/draft/verify", "Draft restored after OTP verification", { draftId: draftDoc.id });

    return NextResponse.json(
      { draftId: draftDoc.id, currentStep: draft.currentStep, formData: draft.formData },
      { headers }
    );
  } catch (err) {
    logError("api/applications/draft/verify", "POST unhandled error", err);
    return NextResponse.json({ error: "Internal server error. Please try again." }, { status: 500, headers });
  }
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
