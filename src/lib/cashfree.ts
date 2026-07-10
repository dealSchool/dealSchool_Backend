import * as crypto from "crypto";

const API_VERSION = "2023-08-01";

export function cashfreeBaseUrl(): string {
  const env = process.env.CASHFREE_ENV || "sandbox";
  return env === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
}

function cashfreeHeaders(): Record<string, string> {
  return {
    "x-client-id":     process.env.CASHFREE_APP_ID!,
    "x-client-secret": process.env.CASHFREE_SECRET_KEY!,
    "x-api-version":   API_VERSION,
    "Content-Type":    "application/json",
  };
}

async function cashfreeFetch(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${cashfreeBaseUrl()}${path}`, { ...init, headers: cashfreeHeaders() });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.message || body?.error_description || `Cashfree API error (${res.status})`;
    throw new Error(message);
  }
  return body;
}

export interface CreatePaymentLinkParams {
  linkId:      string;
  amountPaise: number;
  purpose:     string;
  customer:    { name?: string; email?: string; phone: string };
  notes?:      Record<string, string>;
  returnUrl:   string;
}

export interface PaymentLinkResult {
  linkId:    string;
  linkUrl:   string;
  expiresAt: Date;
}

export async function createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLinkResult> {
  if (!params.customer.phone) {
    throw new Error("Cashfree requires a customer phone number to create a payment link");
  }

  const body = await cashfreeFetch("/links", {
    method: "POST",
    body: JSON.stringify({
      link_id:       params.linkId,
      link_amount:   params.amountPaise / 100,
      link_currency: "INR",
      link_purpose:  params.purpose,
      customer_details: {
        customer_phone: params.customer.phone,
        ...(params.customer.name  ? { customer_name:  params.customer.name }  : {}),
        ...(params.customer.email ? { customer_email: params.customer.email } : {}),
      },
      link_notify: { send_sms: false, send_email: false },
      ...(params.notes ? { link_notes: params.notes } : {}),
      link_meta: { return_url: params.returnUrl },
    }),
  });

  return {
    linkId:    body.link_id,
    linkUrl:   body.link_url,
    expiresAt: new Date(body.link_expiry_time),
  };
}

export async function fetchPaymentLink(linkId: string): Promise<any> {
  return cashfreeFetch(`/links/${encodeURIComponent(linkId)}`, { method: "GET" });
}

export async function cancelPaymentLink(linkId: string): Promise<void> {
  await cashfreeFetch(`/links/${encodeURIComponent(linkId)}/cancel`, { method: "POST" });
}

export interface CreateRefundParams {
  orderId:     string;
  refundId:    string;
  amountPaise: number;
  note?:       string;
}

export async function createRefund(params: CreateRefundParams): Promise<any> {
  return cashfreeFetch(`/orders/${encodeURIComponent(params.orderId)}/refunds`, {
    method: "POST",
    body: JSON.stringify({
      refund_amount: params.amountPaise / 100,
      refund_id:     params.refundId,
      ...(params.note ? { refund_note: params.note } : {}),
    }),
  });
}

export function verifyCashfreeWebhookSignature(rawBody: string, timestamp: string, signatureB64: string): boolean {
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!secret) return false;

  const expected = crypto.createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");

  try {
    const expectedBuf = Buffer.from(expected, "base64");
    const incomingBuf = Buffer.from(signatureB64, "base64");
    return expectedBuf.length === incomingBuf.length && crypto.timingSafeEqual(expectedBuf, incomingBuf);
  } catch {
    return false;
  }
}
