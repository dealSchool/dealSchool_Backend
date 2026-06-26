import nodemailer from "nodemailer";
import { lookup } from "dns";
import { promisify } from "util";
import { logInfo, logWarn, logError } from "@/lib/logger";

const dnsLookup = promisify(lookup);

// Boot-time check — visible in Render startup logs if creds are missing
if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
  logWarn("mailer", "SMTP credentials missing — ALL emails will fail", {
    SMTP_USER: process.env.SMTP_USER ? "set" : "MISSING",
    SMTP_PASS: process.env.SMTP_PASS ? "set" : "MISSING",
    SMTP_HOST: process.env.SMTP_HOST ?? "smtp.gmail.com (default)",
    fix: "Render → your service → Environment → add SMTP_USER + SMTP_PASS",
  });
}

/**
 * Resolve the SMTP hostname to an explicit IPv4 address before connecting.
 *
 * WHY: setDefaultResultOrder("ipv4first") is unreliable on Linux/Render —
 * glibc's getaddrinfo() ignores Node.js's hint and returns IPv6 first when
 * the system's /etc/gai.conf prefers IPv6. Render has no IPv6 route to
 * smtp.gmail.com, so every connection attempt times out after 2 minutes.
 *
 * Explicitly resolving to an IPv4 address bypasses glibc entirely.
 * We also pass tls.servername so Gmail's TLS cert (issued for smtp.gmail.com,
 * not an IP) still validates correctly.
 */
async function resolveIPv4(hostname: string): Promise<string> {
  try {
    const { address } = await dnsLookup(hostname, { family: 4 });
    logInfo("mailer", `DNS resolved ${hostname} → ${address} (IPv4)`);
    return address;
  } catch (err) {
    logWarn("mailer", `IPv4 DNS lookup failed for ${hostname} — falling back to hostname`, {
      hint: "This may still cause ENETUNREACH if the host has no IPv6 route",
    });
    return hostname;
  }
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
  const smtpHostname = process.env.SMTP_HOST || "smtp.gmail.com";
  const smtpPort     = parseInt(process.env.SMTP_PORT || "587");

  // Resolve to IPv4 on every send — cheap (OS-level TTL cache) and guarantees
  // we never accidentally connect via IPv6 after a DNS refresh.
  const smtpHost = await resolveIPv4(smtpHostname);

  const transporter = nodemailer.createTransport({
    host:       smtpHost,     // IPv4 address — never an IPv6 address
    port:       smtpPort,
    secure:     false,
    requireTLS: true,
    tls: {
      servername: smtpHostname, // SNI — Gmail's TLS cert is for smtp.gmail.com, not the IP
    },
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  logInfo("mailer", "Attempting to send email", { to, subject, smtpHost });

  try {
    const info = await transporter.sendMail({ from, to, subject, html });
    logInfo("mailer", "Email sent successfully", {
      to,
      subject,
      smtpHost,
      messageId: info.messageId,
      response:  info.response,
    });
    return info;
  } catch (err: unknown) {
    logError("mailer", `Email send FAILED to="${to}" subject="${subject}"`, err);

    const e   = err as Record<string, unknown>;
    const msg = String(e?.["message"] ?? "");
    if (String(e?.["responseCode"]) === "535" || msg.includes("535")) {
      console.error("  DIAGNOSIS: SMTP auth rejected (535).");
      console.error("  → Check SMTP_USER and SMTP_PASS in Render env vars.");
      console.error("  → SMTP_PASS must be a Google App Password (16 chars).");
    } else if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.error("  DIAGNOSIS: SMTP_USER or SMTP_PASS not set.");
      console.error("  → Render → your service → Environment → add them.");
    } else if (msg.includes("ENETUNREACH") || msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT")) {
      console.error("  DIAGNOSIS: Cannot reach SMTP host.");
      console.error(`  → Tried to connect to: ${smtpHost}:${smtpPort}`);
      console.error(`  → Original hostname: ${smtpHostname}`);
      console.error("  → If this is an IPv6 address, the DNS fix failed — check resolveIPv4() logs above.");
    }

    throw err;
  }
}
