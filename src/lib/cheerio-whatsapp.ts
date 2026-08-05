import { logInfo, logError } from "@/lib/logger";

const CHEERIO_API_URL =
  process.env.CHEERIO_API_URL || "https://newprod.api.cheerio.in/direct-apis/v1/whatsapp/template/send";
const CHEERIO_API_KEY = process.env.CHEERIO_API_KEY;

// Bounds a single send to a fixed worst case — without this, a hung Cheerio
// request blocks its entire concurrency-5 batch (see runWithConcurrency in
// every reminder lib) indefinitely, since Promise.all over that batch can't
// settle until every request in it does.
const REQUEST_TIMEOUT_MS = 15_000;

// Cheerio wants "91XXXXXXXXXX" — the draft stores mobileNumber however the
// applicant typed it (with/without +91, spaces, dashes), so normalize here
// rather than changing what the form collects/stores. Throws (rather than
// silently sending a malformed id) if fewer than 10 digits remain after
// stripping non-digit characters — every call site already wraps this in a
// try/catch that counts it as a normal per-applicant failure, so this can't
// crash a batch, it just correctly skips one bad record instead of guessing.
export function toWhatsAppId(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) {
    throw new Error(`Cannot derive a WhatsApp id from mobileNumber "${raw}" — fewer than 10 digits`);
  }
  return `91${digits}`;
}

export interface SendWhatsAppTemplateParams {
  to: string;
  templateName: string;
  bodyParams: string[];
  // Omit for templates with no call-to-action button (e.g. a plain status update).
  buttonUrl?: string;
}

export async function sendWhatsAppTemplate({
  to,
  templateName,
  bodyParams,
  buttonUrl,
}: SendWhatsAppTemplateParams): Promise<void> {
  if (!CHEERIO_API_KEY) {
    throw new Error("CHEERIO_API_KEY is not set — cannot send WhatsApp template");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(CHEERIO_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": CHEERIO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to,
        data: {
          name: templateName,
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: bodyParams.map((text) => ({ type: "text", text })),
            },
            ...(buttonUrl
              ? [
                  {
                    type: "button",
                    sub_type: "url",
                    index: "0",
                    parameters: [{ type: "text", text: buttonUrl }],
                  },
                ]
              : []),
          ],
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const message = isTimeout ? `Cheerio API request timed out after ${REQUEST_TIMEOUT_MS}ms` : undefined;
    logError("cheerio-whatsapp", `Send failed to=${to} template=${templateName}`, message ? new Error(message) : err);
    throw message ? new Error(message) : err;
  } finally {
    clearTimeout(timeoutId);
  }

  const body = await res.json().catch(() => null);
  // Some APIs (Cheerio's included, per prior send failures seen in logs)
  // return HTTP 200 with an embedded failure — checking res.ok alone would
  // log this as a successful send and let the caller permanently mark the
  // applicant as "reminded" for this stage, with no real retry ever
  // happening. These are the conventional shapes a JSON API uses to signal
  // failure inside a 200; a genuine success response should never match any
  // of them, so this can't turn a real success into a false failure.
  const bodyFailure = body && (body.success === false || body.ok === false || body.status === "error" || body.error);
  if (!res.ok || bodyFailure) {
    const message =
      body?.message ||
      body?.error?.message ||
      (typeof body?.error === "string" ? body.error : undefined) ||
      `Cheerio API error (${res.status})`;
    logError("cheerio-whatsapp", `Send failed to=${to} template=${templateName}`, new Error(message));
    throw new Error(message);
  }

  logInfo("cheerio-whatsapp", "WhatsApp template sent", { to, template: templateName, response: JSON.stringify(body) });
}
