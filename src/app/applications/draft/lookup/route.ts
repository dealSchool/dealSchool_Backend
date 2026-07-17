import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { sendEmail } from "@/lib/mailer";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { sanitizeHeader, maskEmail } from "@/lib/validate";
import { renderDraftOTP } from "@/lib/email-templates";

export const runtime = "nodejs";

const SENDER = "DealSchool <support@dealschool.in>";

const ALREADY_APPLIED_MSG =
  "You've already applied to DealSchool. Our team will reach out to you shortly. For any queries, contact support@dealschool.in";

// ─── POST /applications/draft/lookup — public: check phone for a saved draft ──
// Body: { mobileNumber }
// Never returns saved data directly — if a draft exists, it emails an OTP to
// the email already on file for that draft, so entering a stranger's phone
// number can't leak their name/resume/essay answers.
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const ip      = getClientIp(request);

  const ipRl = await checkRateLimit(`apply-draft-lookup-ip:${ip}`, 20, 15 * 60 * 1000);
  if (!ipRl.allowed) {
    logWarn("api/applications/draft/lookup", "IP rate limited", { ip });
    return NextResponse.json(
      { error: "Too many requests. Please wait before trying again." },
      { status: 429, headers: { ...headers, "Retry-After": String(Math.ceil(ipRl.retryAfterMs / 1000)) } }
    );
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  const mobileNumber = typeof body.mobileNumber === "string" ? sanitizeHeader(body.mobileNumber) : "";
  if (!mobileNumber) {
    return NextResponse.json({ error: "mobileNumber is required" }, { status: 400, headers });
  }

  // Rate limit per phone number too — caps how many OTP emails one number can trigger,
  // separate from the per-IP cap above.
  const phoneRl = await checkRateLimit(`apply-draft-lookup-phone:${mobileNumber}`, 5, 15 * 60 * 1000);
  if (!phoneRl.allowed) {
    return NextResponse.json(
      { error: "Too many requests for this number. Please wait before trying again." },
      { status: 429, headers: { ...headers, "Retry-After": String(Math.ceil(phoneRl.retryAfterMs / 1000)) } }
    );
  }

  const appSnap = await adminDb.collection("applications").where("mobileNumber", "==", mobileNumber).limit(1).get();
  if (!appSnap.empty) {
    return NextResponse.json({ alreadyApplied: true, error: ALREADY_APPLIED_MSG }, { status: 409, headers });
  }

  const draftSnap = await adminDb
    .collection("applicationDrafts")
    .where("mobileNumber", "==", mobileNumber)
    .where("status", "==", "in_progress")
    .limit(1)
    .get();

  if (draftSnap.empty) {
    return NextResponse.json({ found: false }, { headers });
  }

  const draftDoc = draftSnap.docs[0];
  const draft    = draftDoc.data();

  const otpCode   = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));

  await adminDb.collection("draftOtps").doc(draftDoc.id).set({
    otpCode,
    mobileNumber,
    expiresAt,
    used:      false,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    await sendEmail({
      from:    SENDER,
      to:      draft.email,
      subject: "Resume Your DealSchool Application",
      html:    renderDraftOTP({ otpCode }),
    });
    logInfo("api/applications/draft/lookup", "OTP email sent", { draftId: draftDoc.id });
  } catch (err) {
    logError("api/applications/draft/lookup", `OTP email FAILED draftId=${draftDoc.id}`, err);
    return NextResponse.json({ error: "Failed to send verification email" }, { status: 500, headers });
  }

  return NextResponse.json({ found: true, maskedEmail: maskEmail(draft.email) }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
