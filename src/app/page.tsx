import * as crypto from "crypto";

export const runtime = "nodejs";

const FRONTEND_URL = (process.env.APP_BASE_URL || "https://dealschool.netlify.app").replace(/\/$/, "");

const FONT = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

type SearchParams = { [key: string]: string | string[] | undefined };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Verifies the Razorpay Payment Link redirect per their documented scheme —
// https://razorpay.com/docs/payment-links/verify-status/#via-redirect-to-site
// This is display-only: the webhook (src/app/webhooks/razorpay/route.ts)
// remains the sole source of truth for actually marking a payment "paid".
function verifyCallbackSignature(params: {
  paymentLinkId: string;
  referenceId: string;
  status: string;
  paymentId: string;
  signature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;

  const payload  = `${params.paymentLinkId}|${params.referenceId}|${params.status}|${params.paymentId}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  try {
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf   = Buffer.from(params.signature, "hex");
    return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  const paymentId   = first(sp.razorpay_payment_id);
  const linkId      = first(sp.razorpay_payment_link_id);
  const referenceId = first(sp.razorpay_payment_link_reference_id);
  const status      = first(sp.razorpay_payment_link_status);
  const signature   = first(sp.razorpay_signature);

  const isCallback = Boolean(paymentId && linkId && referenceId && status && signature);
  const isVerified = isCallback && verifyCallbackSignature({
    paymentLinkId: linkId!,
    referenceId:   referenceId!,
    status:        status!,
    paymentId:     paymentId!,
    signature:     signature!,
  });
  const isPaid = isVerified && status === "paid";

  let heading: string;
  let message: string;

  if (!isCallback) {
    heading = "DealSchool API";
    message = "This is the DealSchool backend service. There's nothing to see here directly — head to the main site instead.";
  } else if (!isVerified) {
    heading = "We Couldn't Verify This Page";
    message = "This link's signature didn't check out, so we can't confirm your payment status here. Please check your email for a confirmation, or contact support@dealschool.in.";
  } else if (isPaid) {
    heading = "Payment Successful";
    message = "Thank you — your DealSchool Fellowship fee has been received. You can close this tab now; a confirmation email with your receipt is on its way to your inbox.";
  } else {
    heading = "Payment Not Completed";
    message = `Your payment status is "${status}". If this seems wrong, please contact support@dealschool.in.`;
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#ECEAE3",
        fontFamily: FONT,
        padding: "24px",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          background: "#ffffff",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 4px 32px rgba(8,44,108,.13)",
        }}
      >
        <div style={{ background: "#082C6C", padding: "28px 32px 20px" }}>
          <p
            style={{
              margin: 0,
              fontFamily: FONT,
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: 2.5,
              color: "#ffffff",
              textTransform: "uppercase",
            }}
          >
            Deal<span style={{ color: "#D4A62A" }}>School</span>
          </p>
        </div>
        <div style={{ height: 3, background: "linear-gradient(90deg,#B8891A,#D4A62A 40%,#F0C040 70%,#D4A62A)" }} />

        <div style={{ padding: "32px" }}>
          {isCallback && (
            <p
              style={{
                display: "inline-block",
                margin: "0 0 16px",
                padding: "3px 12px",
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: 0.5,
                background: isPaid ? "rgba(34,139,34,0.12)" : "rgba(212,166,42,0.13)",
                color: isPaid ? "#1e7a1e" : "#8A6510",
              }}
            >
              {isPaid ? "PAID" : isVerified ? status?.toUpperCase() : "UNVERIFIED"}
            </p>
          )}

          <h1 style={{ margin: "0 0 12px", fontSize: 22, fontWeight: 700, color: "#082C6C" }}>{heading}</h1>
          <p style={{ margin: "0 0 24px", fontSize: 15, lineHeight: 1.7, color: "#374151" }}>{message}</p>

          {isCallback && isVerified && paymentId && (
            <div
              style={{
                background: "#FAFAF8",
                border: "1px solid #EDE9DE",
                borderRadius: 8,
                padding: "14px 18px",
                marginBottom: 24,
                fontSize: 13,
                color: "#5F6368",
              }}
            >
              <div>
                Payment ID: <span style={{ color: "#111111", fontWeight: 500 }}>{paymentId}</span>
              </div>
            </div>
          )}

          {!isPaid && (
            <a
              href={FRONTEND_URL}
              style={{
                display: "inline-block",
                padding: "12px 28px",
                background: "#082C6C",
                color: "#ffffff",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 600,
                textDecoration: "none",
                letterSpacing: 0.5,
              }}
            >
              Return to DealSchool &rarr;
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
