import { Resend } from "resend";
import { logInfo, logWarn, logError } from "@/lib/logger";

// WHY Resend instead of nodemailer+SMTP:
// Google blocks TCP connections on port 587 from cloud-hosting IP ranges (Render, AWS, etc.)
// as an anti-spam measure — ETIMEDOUT after 2 min, no code fix possible.
// Resend sends via HTTPS (port 443), never blocked, relays through IPs Google trusts.

if (!process.env.RESEND_API_KEY) {
  logWarn("mailer", "RESEND_API_KEY not set — ALL emails will fail", {
    fix: "1. Sign up at resend.com  2. Verify dealschool.in domain  3. Create API key  4. Add RESEND_API_KEY in Render → Environment",
  });
}

// Lazy init — avoids throwing at module load when RESEND_API_KEY is absent (e.g. CI/build)
let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not set. Add it in Render → Environment.");
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

export async function sendEmail({
  from,
  to,
  subject,
  html,
}: {
  from: string;
  to: string;
  subject: string;
  html: string;
}) {
  logInfo("mailer", "Attempting to send email", { to, subject });

  try {
    const { data, error } = await getResend().emails.send({ from, to, subject, html });

    if (error) {
      throw new Error(error.message);
    }

    logInfo("mailer", "Email sent successfully", { to, subject, id: data?.id });
    return data;
  } catch (err: unknown) {
    logError("mailer", `Email send FAILED to="${to}" subject="${subject}"`, err);
    throw err;
  }
}
