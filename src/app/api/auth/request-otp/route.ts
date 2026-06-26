import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { sendEmail } from "@/lib/mailer";
import { renderAdminOTP } from "@/lib/email-templates";

export const runtime = "nodejs";

const ADMIN_SENDER = "DealSchool Admin <admin@dealschool.in>";

// ─── POST /api/auth/request-otp — admin: generate & email OTP for password change
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  let admin: { uid: string; email: string };
  try { admin = await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  const otpCode  = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)); // 10 min

  await adminDb.collection("adminOtps").doc(admin.uid).set({
    otpCode,
    expiresAt,
    used:      false,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    await sendEmail({
      from:    ADMIN_SENDER,
      to:      admin.email,
      subject: "DealSchool Admin Portal — Change Password OTP",
      html:    renderAdminOTP({ otpCode }),
    });
  } catch {
    return NextResponse.json({ error: "Failed to send OTP email" }, { status: 500, headers });
  }

  return NextResponse.json({ success: true }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
