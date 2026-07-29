import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { logInfo, logError } from "@/lib/logger";

export const runtime = "nodejs";

// Human-readable labels for the "applications" collection's `status` field —
// shown in the export so admins don't have to decode raw enum values.
const APPLICATION_STATUS_LABELS: Record<string, string> = {
  pending:            "Pending",
  under_review:       "Under Review (Auditing)",
  interview_invited:  "Interview Invited",
  accepted:           "Accepted / Payment",
  declined:           "Declined",
  cancelled:          "Cancelled",
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  link_sent:      "Payment Link Sent",
  processing:     "Processing",
  error:          "Error",
  expired:        "Link Expired",
  failed:         "Failed",
  paid:           "Paid",
  refund_pending: "Refund Pending",
  refunded:       "Refunded",
  refund_failed:  "Refund Failed",
};

// A draft with no explicit "abandoned" status just sits at "in_progress"
// forever — same heuristic used by GET /applications/draft to label it.
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000; // 24h since last step saved

const COLUMNS = [
  "recordType",
  "id",
  "stage",
  "currentStep",
  "fullName",
  "email",
  "mobileNumber",
  "linkedinUrl",
  "city",
  "occupationStatus",
  "collegeName",
  "degree",
  "graduationYear",
  "currentRole",
  "companyName",
  "yearsOfExperience",
  "degreeEducationalBackground",
  "startupName",
  "industrySector",
  "startupLinkedinProfile",
  "areaOfWork",
  "freelancerLinkedinProfile",
  "otherStatusSpecify",
  "primaryReason",
  "primaryReasonOther",
  "assessmentQ1",
  "assessmentQ2",
  "assessmentQ3",
  "resumeUrl",
  "discoverySource",
  "discoverySourceOther",
  "agreedToTerms",
  "paymentStatus",
  "paymentAmountInr",
  "paidAt",
  "refundPercent",
  "cancellationReason",
  "cancelledAt",
  "applicationId",
  "createdAt",
  "updatedAt",
] as const;

type Row = Record<(typeof COLUMNS)[number], string>;

function blankRow(): Row {
  const row = {} as Row;
  for (const col of COLUMNS) row[col] = "";
  return row;
}

// Fields shared by both a submitted application (top-level) and an in-progress
// draft (nested under formData) — pulled from whichever source is passed in so
// the row-building logic below doesn't have to special-case each collection.
function applyApplicantFields(row: Row, data: Record<string, any>) {
  row.fullName                     = String(data.fullName ?? "");
  row.email                        = String(data.email ?? "");
  row.mobileNumber                 = String(data.mobileNumber ?? "");
  row.linkedinUrl                  = String(data.linkedinUrl ?? "");
  row.city                         = String(data.city ?? "");
  row.occupationStatus             = String(data.currentStatus ?? "");
  row.collegeName                  = String(data.collegeName ?? "");
  row.degree                       = String(data.degree ?? "");
  row.graduationYear               = String(data.graduationYear ?? "");
  row.currentRole                  = String(data.currentRole ?? "");
  row.companyName                  = String(data.companyName ?? "");
  row.yearsOfExperience             = String(data.yearsOfExperience ?? "");
  row.degreeEducationalBackground  = String(data.degreeEducationalBackground ?? "");
  row.startupName                  = String(data.startupName ?? "");
  row.industrySector               = String(data.industrySector ?? "");
  row.startupLinkedinProfile       = String(data.startupLinkedinProfile ?? "");
  row.areaOfWork                   = String(data.areaOfWork ?? "");
  row.freelancerLinkedinProfile    = String(data.freelancerLinkedinProfile ?? "");
  row.otherStatusSpecify           = String(data.otherStatusSpecify ?? "");
  row.primaryReason                = String(data.primaryReason ?? "");
  row.primaryReasonOther           = String(data.primaryReasonOther ?? "");
  row.assessmentQ1                 = String(data.assessmentQ1 ?? "");
  row.assessmentQ2                 = String(data.assessmentQ2 ?? "");
  row.assessmentQ3                 = String(data.assessmentQ3 ?? "");
  row.resumeUrl                    = String(data.resumeUrl || data.resumeLink || "");
  row.discoverySource              = String(data.discoverySource ?? "");
  row.discoverySourceOther         = String(data.discoverySourceOther ?? "");
  row.agreedToTerms                = data.agreedToTerms === true ? "true" : "false";
}

// Every text field here can come straight from an unauthenticated public
// applicant (fullName, assessmentQ1-3, resumeUrl, etc. have no character
// restrictions). A value starting with =, +, -, or @ is executed as a formula
// by Excel/Sheets when the admin opens this file — e.g. an applicant entering
// `=HYPERLINK("http://evil.com","x")` as their name. Prefix with a single
// quote to force those apps to treat the cell as plain text (OWASP CSV
// injection mitigation); the quote is invisible in the rendered cell.
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function toCsvCell(rawValue: string): string {
  const value = neutralizeFormula(rawValue);
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(rows: Row[]): string {
  const header = COLUMNS.join(",");
  const lines  = rows.map((row) => COLUMNS.map((col) => toCsvCell(row[col])).join(","));
  return [header, ...lines].join("\r\n");
}

// ─── GET /applications/export — admin: full CSV export of every applicant ─────
// Covers both the "applications" collection (fully submitted, tracked through
// pending -> under_review -> interview_invited -> accepted/declined/cancelled,
// plus payment/refund status) and the "applicationDrafts" collection (Step 1-5
// in-progress or abandoned, never finalized). A draft that WAS finalized is
// skipped here — its full data already appears as an "applications" row via
// submitApplication(), so including both would duplicate the same person.
export async function GET(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  try {
    const [applicationsSnap, draftsSnap, paymentsSnap] = await Promise.all([
      adminDb.collection("applications").orderBy("createdAt", "desc").get(),
      adminDb.collection("applicationDrafts").orderBy("updatedAt", "desc").get(),
      adminDb.collection("payments").get(),
    ]);

    const paymentsById = new Map<string, Record<string, any>>();
    for (const doc of paymentsSnap.docs) {
      paymentsById.set(doc.id, serializeDoc(doc.data()));
    }

    const rows: Row[] = [];

    // ── Fully submitted applications ──────────────────────────────────────────
    for (const doc of applicationsSnap.docs) {
      const data    = serializeDoc(doc.data());
      const payment = paymentsById.get(doc.id);
      const row     = blankRow();

      row.recordType   = "Application";
      row.id           = doc.id;
      row.applicationId = doc.id;
      row.stage        = APPLICATION_STATUS_LABELS[String(data.status)] || String(data.status ?? "");
      row.currentStep  = "Submitted";
      applyApplicantFields(row, data);

      const paymentStatus = String(data.paymentStatus ?? payment?.status ?? "");
      row.paymentStatus     = PAYMENT_STATUS_LABELS[paymentStatus] || paymentStatus;
      row.paymentAmountInr  = payment?.amount != null ? String(payment.amount / 100) : "";
      row.paidAt            = String(data.paidAt ?? payment?.paidAt ?? "");
      row.refundPercent     = data.refundPercent != null ? String(data.refundPercent) : "";
      row.cancellationReason = String(data.cancellationReason ?? "");
      row.cancelledAt       = String(data.cancelledAt ?? "");
      row.createdAt         = String(data.createdAt ?? "");
      row.updatedAt         = String(data.updatedAt ?? "");

      rows.push(row);
    }

    // ── In-progress / abandoned drafts (never finalized) ──────────────────────
    const now = Date.now();
    for (const doc of draftsSnap.docs) {
      const data = serializeDoc(doc.data());
      if (data.status === "submitted") continue; // already represented above

      const updatedAt   = data.updatedAt ? new Date(data.updatedAt).getTime() : now;
      const isAbandoned = now - updatedAt > ABANDONED_AFTER_MS;
      const step        = Number(data.currentStep) || 1;

      const row = blankRow();
      row.recordType  = "Draft";
      row.id          = doc.id;
      row.stage       = isAbandoned ? "Abandoned" : "In Progress";
      row.currentStep = `Step ${step} of 5`;
      applyApplicantFields(row, { ...data.formData, email: data.email, mobileNumber: data.mobileNumber });
      row.createdAt = String(data.createdAt ?? "");
      row.updatedAt = String(data.updatedAt ?? "");

      rows.push(row);
    }

    const csv = toCsv(rows);
    const filename = `applicants-export-${new Date().toISOString().slice(0, 10)}.csv`;

    logInfo("api/applications/export", "CSV export generated", {
      applications: String(applicationsSnap.size),
      drafts:       String(rows.length - applicationsSnap.size),
      total:        String(rows.length),
    });

    return new NextResponse(csv, {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        // Content-Disposition isn't in the browser's default CORS-safelisted
        // response headers — without this, the frontend's cross-origin fetch
        // can't read the filename via res.headers.get() and silently falls
        // back to a client-generated name.
        "Access-Control-Expose-Headers": "Content-Disposition",
      },
    });
  } catch (err) {
    logError("api/applications/export", "GET unhandled error", err);
    return NextResponse.json({ error: "Internal server error. Please try again." }, { status: 500, headers });
  }
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
