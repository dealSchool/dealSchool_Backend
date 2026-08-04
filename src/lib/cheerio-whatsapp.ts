import { logInfo, logError } from "@/lib/logger";

const CHEERIO_API_URL =
  process.env.CHEERIO_API_URL || "https://newprod.api.cheerio.in/direct-apis/v1/whatsapp/template/send";
const CHEERIO_API_KEY = process.env.CHEERIO_API_KEY;

// Cheerio wants "91XXXXXXXXXX" — the draft stores mobileNumber however the
// applicant typed it (with/without +91, spaces, dashes), so normalize here
// rather than changing what the form collects/stores.
export function toWhatsAppId(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(-10);
  return `91${digits}`;
}

export interface SendWhatsAppTemplateParams {
  to: string;
  templateName: string;
  bodyParams: string[];
  buttonUrl: string;
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

  const res = await fetch(CHEERIO_API_URL, {
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
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: buttonUrl }],
          },
        ],
      },
    }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.message || body?.error?.message || `Cheerio API error (${res.status})`;
    logError("cheerio-whatsapp", `Send failed to=${to} template=${templateName}`, new Error(message));
    throw new Error(message);
  }

  logInfo("cheerio-whatsapp", "WhatsApp template sent", { to, template: templateName });
}
