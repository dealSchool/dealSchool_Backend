import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { sendEmail } from "@/lib/mailer";
import { logInfo, logError } from "@/lib/logger";
import { renderAdminPasswordReset } from "@/lib/email-templates";

export const runtime = "nodejs";

const ADMIN_SENDER = "DealSchool Admin <admin@dealschool.in>";

// ─── POST /api/auth/forgot-password — public ─────────────────────────────────
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  const { email } = body;
  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400, headers });
  }

  logInfo("api/auth/forgot-password", "Password reset requested", { email: String(email) });

  // Generate link and send email — silently ignore errors to avoid leaking
  // whether an account exists for the given email address.
  try {
    const resetLink = await adminAuth.generatePasswordResetLink(String(email));
    await sendEmail({
      from:    ADMIN_SENDER,
      to:      String(email),
      subject: "DealSchool Admin Portal — Password Reset",
      html:    renderAdminPasswordReset({ resetLink }),
    });
    logInfo("api/auth/forgot-password", "Password reset email sent OK", { email: String(email) });
  } catch (err) {
    logError("api/auth/forgot-password", `Password reset email FAILED email=${String(email)}`, err);
    // non-fatal: always return 200 to avoid leaking whether the account exists
  }

  return NextResponse.json({ success: true }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
