import { logInfo, logError } from "@/lib/logger";

// Separate endpoint from cheerio-whatsapp.ts (Cheerio's WhatsApp template send
// API) — this is Cheerio's single-email send API, used to fire the same
// lifecycle reminder emails documented in the "Curl" column of the DealSchool
// Email Templates sheet. Both share the same Cheerio account/API key.
const CHEERIO_EMAIL_API_URL =
  process.env.CHEERIO_EMAIL_API_URL || "https://newprod.api.cheerio.in/direct-apis/v1/announcements/single-email/send";
const CHEERIO_API_KEY = process.env.CHEERIO_API_KEY;

// Bounds a single send to a fixed worst case — same reasoning as
// cheerio-whatsapp.ts: without this, a hung Cheerio request blocks its
// entire concurrency-5 batch (see runWithConcurrency in every reminder lib)
// indefinitely, since Promise.all over that batch can't settle until every
// request in it does.
const REQUEST_TIMEOUT_MS = 15_000;

export interface SendCheerioEmailParams {
  to: string;
  subject: string;
  htmlContent: string;
  // Cheerio groups sends under a campaign name in its dashboard — defaults to
  // the WhatsApp-equivalent template name so the two channels line up 1:1
  // when reviewing send history there.
  campaignName: string;
}

export async function sendCheerioEmail({ to, subject, htmlContent, campaignName }: SendCheerioEmailParams): Promise<void> {
  if (!CHEERIO_API_KEY) {
    throw new Error("CHEERIO_API_KEY is not set — cannot send Cheerio email");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(CHEERIO_EMAIL_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": CHEERIO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: to,
        campaignName,
        subject,
        htmlContent,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const message = isTimeout ? `Cheerio email API request timed out after ${REQUEST_TIMEOUT_MS}ms` : undefined;
    logError("cheerio-email", `Send failed to=${to} campaign=${campaignName}`, message ? new Error(message) : err);
    throw message ? new Error(message) : err;
  } finally {
    clearTimeout(timeoutId);
  }

  const body = await res.json().catch(() => null);
  // Same 200-with-embedded-failure shape seen from Cheerio's WhatsApp API
  // (see cheerio-whatsapp.ts) — checking res.ok alone risks logging a
  // rejected send as successful.
  const bodyFailure = body && (body.success === false || body.ok === false || body.status === "error" || body.error);
  if (!res.ok || bodyFailure) {
    const message =
      body?.message ||
      body?.error?.message ||
      (typeof body?.error === "string" ? body.error : undefined) ||
      `Cheerio email API error (${res.status})`;
    logError("cheerio-email", `Send failed to=${to} campaign=${campaignName}`, new Error(message));
    throw new Error(message);
  }

  logInfo("cheerio-email", "Email sent", { to, campaign: campaignName, response: JSON.stringify(body) });
}
