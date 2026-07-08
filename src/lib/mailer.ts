import nodemailer, { type Transporter } from "nodemailer";
import { logInfo, logWarn, logError } from "@/lib/logger";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 465);
const SMTP_SECURE = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : SMTP_PORT === 465;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  logWarn("mailer", "SMTP_HOST/SMTP_USER/SMTP_PASS not set — ALL emails will fail", {
    fix: "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in the environment",
  });
}

// Lazy init — avoids throwing at module load when SMTP env vars are absent (e.g. CI/build)
let _transporter: Transporter | null = null;
function getTransporter(): Transporter {
  if (!_transporter) {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      throw new Error("SMTP_HOST, SMTP_USER, and SMTP_PASS must be set to send email.");
    }
    _transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return _transporter;
}

export async function sendEmail({
  from,
  to,
  subject,
  html,
  attachments,
}: {
  from: string;
  to: string;
  subject: string;
  html: string;
  attachments?: { filename: string; content: Buffer }[];
}) {
  logInfo("mailer", "Attempting to send email", { to, subject });

  try {
    const info = await getTransporter().sendMail({ from, to, subject, html, ...(attachments ? { attachments } : {}) });

    logInfo("mailer", "Email sent successfully", { to, subject, id: info.messageId });
    return info;
  } catch (err: unknown) {
    logError("mailer", `Email send FAILED to="${to}" subject="${subject}"`, err);
    throw err;
  }
}
