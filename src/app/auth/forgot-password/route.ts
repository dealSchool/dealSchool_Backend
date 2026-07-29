import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { sendEmail } from "@/lib/mailer";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { renderAdminPasswordReset } from "@/lib/email-templates";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const ADMIN_SENDER = "DealSchool Admin <support@dealschool.in>";

// ─── POST /auth/forgot-password — public ──────────────────────────────────────
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const ip      = getClientIp(request);

  const rl = checkRateLimit(`forgot-password:${ip}`, 5, 15 * 60 * 1000);
  if (!rl.allowed) {
    logWarn("api/auth/forgot-password", "Rate limited", { ip });
    return NextResponse.json(
      { error: "Too many requests. Please wait before trying again." },
      { status: 429, headers: { ...headers, "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

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
      subject: "DealSchool Admin Portal: Password Reset",
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
