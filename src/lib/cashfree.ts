import * as crypto from "crypto";
import { getPaymentMode, type PaymentMode } from "./payment-mode-settings";

const API_VERSION = "2023-08-01";

// Sandbox falls back to the legacy unsuffixed vars so existing .env.local
// setups keep working; live requires its own explicit *_LIVE pair — sandbox
// and live are separate Cashfree accounts with different credentials.
const CASHFREE_CREDENTIALS: Record<PaymentMode, { appId: string; secretKey: string }> = {
  sandbox: {
    appId:     process.env.CASHFREE_APP_ID_SANDBOX     || process.env.CASHFREE_APP_ID     || "",
    secretKey: process.env.CASHFREE_SECRET_KEY_SANDBOX || process.env.CASHFREE_SECRET_KEY || "",
  },
  live: {
    appId:     process.env.CASHFREE_APP_ID_LIVE     || "",
    secretKey: process.env.CASHFREE_SECRET_KEY_LIVE || "",
  },
};

export async function cashfreeBaseUrl(): Promise<string> {
  const mode = await getPaymentMode();
  return mode === "live" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
}

async function cashfreeHeaders(): Promise<Record<string, string>> {
  const mode = await getPaymentMode();
  const { appId, secretKey } = CASHFREE_CREDENTIALS[mode];
  return {
    "x-client-id":     appId,
    "x-client-secret": secretKey,
    "x-api-version":   API_VERSION,
    "Content-Type":    "application/json",
  };
}

async function cashfreeFetch(path: string, init: RequestInit): Promise<any> {
  const [baseUrl, headers] = await Promise.all([cashfreeBaseUrl(), cashfreeHeaders()]);
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
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
  notifyUrl:   string;
}

export interface PaymentLinkResult {
  linkId:    string;
  linkUrl:   string;
  expiresAt: Date;
}

// Cashfree wants a bare 10-digit Indian mobile number — the application form
// stores it with a "+91" (or similar) prefix, so strip everything down to the
// last 10 digits here rather than changing what the form collects/stores.
function normalizeIndianMobile(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.slice(-10);
}

export async function createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLinkResult> {
  if (!params.customer.phone) {
    throw new Error("Cashfree requires a customer phone number to create a payment link");
  }
  const customerPhone = normalizeIndianMobile(params.customer.phone);
  if (customerPhone.length !== 10) {
    throw new Error(`Customer phone "${params.customer.phone}" does not contain a valid 10-digit mobile number`);
  }

  const body = await cashfreeFetch("/links", {
    method: "POST",
    body: JSON.stringify({
      link_id:       params.linkId,
      link_amount:   params.amountPaise / 100,
      link_currency: "INR",
      link_purpose:  params.purpose,
      customer_details: {
        customer_phone: customerPhone,
        ...(params.customer.name  ? { customer_name:  params.customer.name }  : {}),
        ...(params.customer.email ? { customer_email: params.customer.email } : {}),
      },
      link_notify: { send_sms: false, send_email: false },
      ...(params.notes ? { link_notes: params.notes } : {}),
      // Payment Link webhooks (PAYMENT_LINK_EVENT) are delivered to this
      // per-link notify_url, NOT via the merchant dashboard's general
      // Webhooks config — that screen only covers order/payment/refund
      // events. Without this, "paid" notifications never arrive.
      //
      // return_url is deliberately omitted: Cashfree's own docs say that
      // without one, the customer lands on Cashfree's default post-payment
      // page instead of being redirected back to us — which is what we want
      // here (no redirect to our own site after paying via the emailed link).
      link_meta: { notify_url: params.notifyUrl },
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

export async function fetchOrderPayments(orderId: string): Promise<any[]> {
  const body = await cashfreeFetch(`/orders/${encodeURIComponent(orderId)}/payments`, { method: "GET" });
  return Array.isArray(body) ? body : [];
}

// payment_method is a Cashfree "oneOf" object — exactly one of these keys is
// present depending on how the customer actually paid.
export function describePaymentMethod(paymentMethod: any): string {
  if (!paymentMethod || typeof paymentMethod !== "object") return "N/A";
  if (paymentMethod.card) {
    const c = paymentMethod.card;
    const network = c.card_network ? String(c.card_network).toUpperCase() : "Card";
    const type = c.card_type === "credit_card" ? "Credit" : c.card_type === "debit_card" ? "Debit" : "";
    return `${network} ${type} Card`.replace(/\s+/g, " ").trim();
  }
  if (paymentMethod.upi) return "UPI";
  if (paymentMethod.netbanking) {
    const bank = paymentMethod.netbanking.netbanking_bank_name;
    return bank ? `Netbanking (${bank})` : "Netbanking";
  }
  if (paymentMethod.app) return paymentMethod.app.provider ? `${paymentMethod.app.provider} Wallet` : "Wallet";
  if (paymentMethod.paylater) return paymentMethod.paylater.provider ? `Pay Later (${paymentMethod.paylater.provider})` : "Pay Later";
  if (paymentMethod.cardless_emi) return "Cardless EMI";
  if (paymentMethod.emi) return "Card EMI";
  if (paymentMethod.banktransfer) return "Bank Transfer";
  return "N/A";
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

// Checked against every configured secret (sandbox + live), not just whichever
// mode is currently active — a webhook can arrive after the admin has already
// toggled the mode again, and its signature was computed with the OLD mode's
// secret, not the current one.
export function verifyCashfreeWebhookSignature(rawBody: string, timestamp: string, signatureB64: string): boolean {
  const secrets = Object.values(CASHFREE_CREDENTIALS).map((c) => c.secretKey).filter(Boolean);

  return secrets.some((secret) => {
    const expected = crypto.createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");
    try {
      const expectedBuf = Buffer.from(expected, "base64");
      const incomingBuf = Buffer.from(signatureB64, "base64");
      return expectedBuf.length === incomingBuf.length && crypto.timingSafeEqual(expectedBuf, incomingBuf);
    } catch {
      return false;
    }
  });
}
