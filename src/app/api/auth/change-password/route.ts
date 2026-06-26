import { NextRequest, NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { logInfo, logWarn, logError } from "@/lib/logger";

export const runtime = "nodejs";

// ─── POST /api/auth/change-password — admin: verify OTP then update password ──
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  logInfo("api/auth/change-password", "POST received");

  let admin: { uid: string; email: string };
  try { admin = await verifyAdmin(request); }
  catch {
    logWarn("api/auth/change-password", "Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  let body: any;
  try { body = await request.json(); }
  catch {
    logWarn("api/auth/change-password", "Invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  const { otp, newPassword } = body;
  if (!otp || !newPassword) {
    logWarn("api/auth/change-password", "Missing otp or newPassword", { adminUid: admin.uid });
    return NextResponse.json({ error: "otp and newPassword are required" }, { status: 400, headers });
  }
  if (String(newPassword).length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400, headers });
  }

  const otpRef  = adminDb.collection("adminOtps").doc(admin.uid);
  const otpSnap = await otpRef.get();

  if (!otpSnap.exists) {
    logWarn("api/auth/change-password", "No OTP document found", { adminUid: admin.uid });
    return NextResponse.json({ error: "No OTP found. Please request a new one." }, { status: 400, headers });
  }

  const otpData = otpSnap.data()!;

  if (otpData.used) {
    logWarn("api/auth/change-password", "OTP already used", { adminUid: admin.uid });
    return NextResponse.json({ error: "OTP already used. Please request a new one." }, { status: 400, headers });
  }

  if ((otpData.expiresAt as Timestamp).seconds < Timestamp.now().seconds) {
    logWarn("api/auth/change-password", "OTP expired", { adminUid: admin.uid });
    return NextResponse.json({ error: "OTP has expired. Please request a new one." }, { status: 400, headers });
  }

  if (otpData.otpCode !== String(otp)) {
    logWarn("api/auth/change-password", "Invalid OTP submitted", { adminUid: admin.uid });
    return NextResponse.json({ error: "Invalid OTP." }, { status: 400, headers });
  }

  await otpRef.update({ used: true, usedAt: FieldValue.serverTimestamp() });

  try {
    await adminAuth.updateUser(admin.uid, { password: String(newPassword) });
    logInfo("api/auth/change-password", "Password updated successfully", { adminUid: admin.uid, adminEmail: admin.email });
  } catch (err: unknown) {
    logError("api/auth/change-password", `Firebase updateUser FAILED adminUid=${admin.uid}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to update password: ${msg}` },
      { status: 500, headers },
    );
  }

  return NextResponse.json({ success: true }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
