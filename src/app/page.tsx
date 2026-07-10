import { adminDb } from "@/lib/firebase-admin";

export const runtime = "nodejs";

const FRONTEND_URL = (process.env.APP_BASE_URL || "https://dealschool.netlify.app").replace(/\/$/, "");

const FONT = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

type SearchParams = { [key: string]: string | string[] | undefined };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const applicationId = first(sp.aid);

  // Cashfree's redirect carries no signed status params (unlike Razorpay) —
  // its own docs recommend against trusting redirect query params at all, so
  // this reads our own already-verified Firestore state instead. The webhook
  // (src/app/webhooks/cashfree/route.ts) remains the sole source of truth for
  // actually marking a payment "paid"; this page is display-only.
  let status: string | undefined;
  if (applicationId) {
    const snap = await adminDb.collection("payments").doc(applicationId).get();
    status = snap.exists ? (snap.data()!.status as string | undefined) : undefined;
  }

  const isCallback = Boolean(applicationId);
  const isPaid = status === "paid";

  let heading: string;
  let message: string;

  if (!isCallback) {
    heading = "DealSchool API";
    message = "This is the DealSchool backend service. There's nothing to see here directly — head to the main site instead.";
  } else if (isPaid) {
    heading = "Payment Successful";
    message = "Thank you — your DealSchool Fellowship fee has been received. You can close this tab now; a confirmation email with your receipt is on its way to your inbox.";
  } else if (!status) {
    heading = "We Couldn't Find This Payment";
    message = "We couldn't locate a payment record for this link. If you believe this is a mistake, please contact support@dealschool.in.";
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
          {isCallback && status && (
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
              {status.toUpperCase()}
            </p>
          )}

          <h1 style={{ margin: "0 0 12px", fontSize: 22, fontWeight: 700, color: "#082C6C" }}>{heading}</h1>
          <p style={{ margin: "0 0 24px", fontSize: 15, lineHeight: 1.7, color: "#374151" }}>{message}</p>

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
