import nodemailer from "nodemailer";
import { setDefaultResultOrder } from "dns";
import { logInfo, logWarn, logError } from "@/lib/logger";

// smtp.gmail.com resolves to both IPv4 and IPv6. On hosts without an IPv6
// route (Render, some local networks), Node picks IPv6 first → ENETUNREACH.
// Force IPv4-first so the connection always goes to the reachable address.
setDefaultResultOrder("ipv4first");

// Boot-time check — visible in Render startup logs immediately if creds are missing
if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
  logWarn("mailer", "SMTP credentials missing — ALL emails will fail", {
    SMTP_USER: process.env.SMTP_USER ? "set" : "MISSING",
    SMTP_PASS: process.env.SMTP_PASS ? "set" : "MISSING",
    SMTP_HOST: process.env.SMTP_HOST ?? "smtp.gmail.com (default)",
    fix: "Go to Render → your service → Environment and add SMTP_USER + SMTP_PASS",
  });
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

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
    const info = await transporter.sendMail({ from, to, subject, html });
    logInfo("mailer", "Email sent successfully", {
      to,
      subject,
      messageId: info.messageId,
      response:  info.response,
    });
    return info;
  } catch (err: unknown) {
    logError("mailer", `Email send FAILED to="${to}" subject="${subject}"`, err);

    // Extra diagnosis lines — makes Render logs immediately actionable
    const e = err as Record<string, unknown>;
    const msg = String(e?.["message"] ?? "");
    if (String(e?.["responseCode"]) === "535" || msg.includes("535")) {
      console.error("  DIAGNOSIS: SMTP auth rejected (535).");
      console.error("  → SMTP_USER and SMTP_PASS must be set in Render env vars.");
      console.error("  → SMTP_PASS must be a Google App Password (16 chars) — regular passwords no longer work.");
    } else if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.error("  DIAGNOSIS: SMTP_USER or SMTP_PASS is not set in this environment.");
      console.error("  → Render → your service → Environment → add SMTP_USER and SMTP_PASS.");
    } else if (msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT") || msg.includes("connect")) {
      console.error("  DIAGNOSIS: Cannot reach SMTP host.");
      console.error(`  → Current SMTP_HOST=${process.env.SMTP_HOST ?? "smtp.gmail.com"} SMTP_PORT=${process.env.SMTP_PORT ?? "587"}`);
    }

    throw err; // re-throw so each call site can add its own context
  }
}
