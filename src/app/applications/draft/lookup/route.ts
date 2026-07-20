import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { sendEmail } from "@/lib/mailer";
import { logInfo, logError } from "@/lib/logger";
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

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  const mobileNumber = typeof body.mobileNumber === "string" ? sanitizeHeader(body.mobileNumber) : "";
  if (!mobileNumber) {
    return NextResponse.json({ error: "mobileNumber is required" }, { status: 400, headers });
  }

  try {
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
  } catch (err) {
    logError("api/applications/draft/lookup", "POST unhandled error", err);
    return NextResponse.json({ error: "Internal server error. Please try again." }, { status: 500, headers });
  }
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
