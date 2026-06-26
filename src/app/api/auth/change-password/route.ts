import { NextRequest, NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";

export const runtime = "nodejs";

// ─── POST /api/auth/change-password — admin: verify OTP then update password ──
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  let admin: { uid: string; email: string };
  try { admin = await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  const { otp, newPassword } = body;
  if (!otp || !newPassword) {
    return NextResponse.json({ error: "otp and newPassword are required" }, { status: 400, headers });
  }
  if (String(newPassword).length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400, headers });
  }

  const otpRef  = adminDb.collection("adminOtps").doc(admin.uid);
  const otpSnap = await otpRef.get();

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
    return NextResponse.json({ error: "Invalid OTP." }, { status: 400, headers });
  }

  await otpRef.update({ used: true, usedAt: FieldValue.serverTimestamp() });

  try {
    await adminAuth.updateUser(admin.uid, { password: String(newPassword) });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Failed to update password: ${err.message}` },
      { status: 500, headers },
    );
  }

  return NextResponse.json({ success: true }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
