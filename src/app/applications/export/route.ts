import { NextRequest, NextResponse } from "next/server";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { logInfo, logError } from "@/lib/logger";
import { cohortOf, parseCohortFilter } from "@/lib/cohort-settings";

export const runtime = "nodejs";

// Human-readable labels for the "applications" collection's `status` field —
// shown in the export so admins don't have to decode raw enum values.
const APPLICATION_STATUS_LABELS: Record<string, string> = {
  pending:              "Pending",
  under_review:         "Under Review (Auditing)",
  interview_invited:    "Interview Invited",
  interview_completed:  "Interview Completed",
  accepted:             "Accepted / Payment",
  declined:             "Declined",
  cancelled:            "Cancelled",
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

// Rows are flushed to the client in chunks of this many lines instead of one
// at a time — cuts down on stream-controller overhead for large exports
// without holding more than a small, fixed window of rows in memory.
const STREAM_BATCH_SIZE = 250;

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

// Every text field here can come straight from an unauthenticated public
// applicant/visitor (name, message, assessment answers, resume URL, etc. have
// no character restrictions). A value starting with =, +, -, or @ is executed
// as a formula by Excel/Sheets when the admin opens this file — e.g. someone
// entering `=HYPERLINK("http://evil.com","x")` as their name. Prefix with a
// single quote to force those apps to treat the cell as plain text (OWASP CSV
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

function csvLine(values: string[]): string {
  return values.map(toCsvCell).join(",");
}

// Fields shared by both a submitted application (top-level) and an in-progress
// draft (nested under formData) — order here must match the tail shared by
// both APPLICATION_COLUMNS and DRAFT_COLUMNS below.
function applicantCoreValues(data: Record<string, any>): string[] {
  return [
    String(data.fullName ?? ""),
    String(data.email ?? ""),
    String(data.mobileNumber ?? ""),
    String(data.linkedinUrl ?? ""),
    String(data.city ?? ""),
    String(data.currentStatus ?? ""),
    String(data.collegeName ?? ""),
    String(data.degree ?? ""),
    String(data.graduationYear ?? ""),
    String(data.currentRole ?? ""),
    String(data.companyName ?? ""),
    String(data.yearsOfExperience ?? ""),
    String(data.degreeEducationalBackground ?? ""),
    String(data.startupName ?? ""),
    String(data.industrySector ?? ""),
    String(data.startupLinkedinProfile ?? ""),
    String(data.areaOfWork ?? ""),
    String(data.freelancerLinkedinProfile ?? ""),
    String(data.otherStatusSpecify ?? ""),
    String(data.primaryReason ?? ""),
    String(data.primaryReasonOther ?? ""),
    String(data.assessmentQ1 ?? ""),
    String(data.assessmentQ2 ?? ""),
    String(data.assessmentQ3 ?? ""),
    String(data.resumeUrl || data.resumeLink || ""),
    String(data.discoverySource ?? ""),
    String(data.discoverySourceOther ?? ""),
  ];
}

const APPLICANT_CORE_COLUMNS = [
  "fullName", "email", "mobileNumber", "linkedinUrl", "city", "occupationStatus",
  "collegeName", "degree", "graduationYear", "currentRole", "companyName",
  "yearsOfExperience", "degreeEducationalBackground", "startupName", "industrySector",
  "startupLinkedinProfile", "areaOfWork", "freelancerLinkedinProfile", "otherStatusSpecify",
  "primaryReason", "primaryReasonOther", "assessmentQ1", "assessmentQ2", "assessmentQ3",
  "resumeUrl", "discoverySource", "discoverySourceOther",
];

const APPLICATION_COLUMNS = [
  "id", "stage", ...APPLICANT_CORE_COLUMNS,
  "agreedToTerms", "paymentStatus", "paymentAmountInr", "paidAt",
  "refundPercent", "cancellationReason", "cancelledAt", "createdAt", "updatedAt", "cohort",
];

const DRAFT_COLUMNS = [
  "id", "stage", "currentStep", ...APPLICANT_CORE_COLUMNS, "createdAt", "updatedAt", "cohort",
];

const CONTACT_COLUMNS = [
  "id", "status", "name", "email", "subject", "message",
  "replyCount", "repliesSummary", "createdAt", "updatedAt", "cohort",
];

const BROCHURE_COLUMNS = [
  "id", "name", "email", "contact", "city", "ip", "createdAt", "updatedAt", "cohort",
];

// Casts a Firestore Query.stream() (typed as NodeJS.ReadableStream) to the
// async-iterable shape it actually emits — QueryDocumentSnapshot per item —
// so it can be consumed with `for await`.
function asDocStream(stream: NodeJS.ReadableStream): AsyncIterable<QueryDocumentSnapshot> {
  return stream as unknown as AsyncIterable<QueryDocumentSnapshot>;
}

// A missing/unparseable date sorts as 0 (oldest) rather than being excluded —
// unlike Firestore's own orderBy(), this never drops a row for lacking the field.
function toSortKey(value: unknown): number {
  if (!value) return 0;
  const t = new Date(String(value)).getTime();
  return Number.isFinite(t) ? t : 0;
}

// Reads a whole section via Query.stream() (still memory-bounded on the
// Firestore-fetch side — nothing blocks on one giant round trip) and buffers
// only the small, already-rendered CSV lines (not raw documents) so they can
// be sorted newest-first before being handed off — restores the ordering
// every other admin list view already has, without the completeness risk of
// an orderBy() on a field some documents don't have. At this app's realistic
// scale (hundreds to low thousands of rows per section) this buffer is a
// trivial amount of memory; each section still starts flushing to the client
// as soon as ITS OWN documents have been read, not after the whole export.
async function collectSorted(
  stream: AsyncIterable<QueryDocumentSnapshot>,
  buildRow: (doc: QueryDocumentSnapshot) => { sortKey: number; line: string } | null
): Promise<string[]> {
  const rows: { sortKey: number; line: string }[] = [];
  for await (const doc of stream) {
    const row = buildRow(doc);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.sortKey - a.sortKey); // newest first; missing dates (key 0) sort last
  return rows.map((r) => r.line);
}

// Produces every section's CSV lines, section by section. Each section reads
// its collection via Query.stream() (Firestore-side incremental fetch, no
// single giant round trip) and buffers only the small rendered lines — not
// raw documents — long enough to sort them newest-first; see collectSorted().
// A section's rows are only handed to the HTTP stream once that section's
// own collection has been fully read, but sections themselves are still
// produced one at a time rather than the whole export waiting to finish
// before anything is sent to the client.
async function* generateRows(
  paymentsById: Map<string, Record<string, any>>,
  cohort: number | null,
): AsyncGenerator<string> {
  let appCount = 0, draftCount = 0, contactCount = 0, brochureCount = 0;

  // ── SECTION 1: Submitted applications ──────────────────────────────────────
  yield "SECTION 1 - SUBMITTED APPLICATIONS";
  yield APPLICATION_COLUMNS.join(",");
  // No .orderBy() here deliberately — Firestore silently excludes any document
  // missing the sort field from an orderBy query's results (confirmed: 2 stray
  // application docs with no `createdAt` field were invisible to an
  // orderBy("createdAt") query even though .count() saw them). Sorting is done
  // in-memory below instead, after every document is guaranteed to be read.
  const appStream = adminDb.collection("applications").stream();
  const appLines = await collectSorted(asDocStream(appStream), (doc) => {
    const data    = serializeDoc(doc.data());
    if (cohort !== null && cohortOf(data) !== cohort) return null;
    const payment = paymentsById.get(doc.id);
    const paymentStatus = String(data.paymentStatus ?? payment?.status ?? "");

    const line = csvLine([
      doc.id,
      APPLICATION_STATUS_LABELS[String(data.status)] || String(data.status ?? ""),
      ...applicantCoreValues(data),
      data.agreedToTerms === true ? "true" : "false",
      PAYMENT_STATUS_LABELS[paymentStatus] || paymentStatus,
      payment?.amount != null ? String(payment.amount / 100) : "",
      String(data.paidAt ?? payment?.paidAt ?? ""),
      data.refundPercent != null ? String(data.refundPercent) : "",
      String(data.cancellationReason ?? ""),
      String(data.cancelledAt ?? ""),
      String(data.createdAt ?? ""),
      String(data.updatedAt ?? ""),
      String(cohortOf(data)),
    ]);
    return { sortKey: toSortKey(data.createdAt), line };
  });
  for (const line of appLines) yield line;
  appCount = appLines.length;
  yield "";

  // ── SECTION 2: In-progress / abandoned drafts (never finalized) ────────────
  yield "SECTION 2 - IN PROGRESS OR ABANDONED APPLICATIONS (DRAFTS)";
  yield DRAFT_COLUMNS.join(",");
  const now = Date.now();
  // No .orderBy() here either, for the same reason — a draft missing
  // `updatedAt` would otherwise be silently dropped from the export.
  const draftStream = adminDb.collection("applicationDrafts").stream();
  const draftLines = await collectSorted(asDocStream(draftStream), (doc) => {
    const data = serializeDoc(doc.data());
    if (data.status === "submitted") return null; // already represented in Section 1
    if (cohort !== null && cohortOf(data) !== cohort) return null;

    const updatedAtMs = data.updatedAt ? new Date(data.updatedAt).getTime() : now;
    const isAbandoned = now - updatedAtMs > ABANDONED_AFTER_MS;
    const step        = Number(data.currentStep) || 1;

    const line = csvLine([
      doc.id,
      isAbandoned ? "Abandoned" : "In Progress",
      `Step ${step} of 5`,
      ...applicantCoreValues({ ...data.formData, email: data.email, mobileNumber: data.mobileNumber }),
      String(data.createdAt ?? ""),
      String(data.updatedAt ?? ""),
      String(cohortOf(data)),
    ]);
    return { sortKey: toSortKey(data.updatedAt), line };
  });
  for (const line of draftLines) yield line;
  draftCount = draftLines.length;
  yield "";

  // ── SECTION 3: Contact messages ─────────────────────────────────────────────
  yield "SECTION 3 - CONTACT MESSAGES";
  yield CONTACT_COLUMNS.join(",");
  // No .orderBy() — same completeness reason as Section 1.
  const contactStream = adminDb.collection("contacts").stream();
  const contactLines = await collectSorted(asDocStream(contactStream), (doc) => {
    const data = serializeDoc(doc.data());
    if (cohort !== null && cohortOf(data) !== cohort) return null;
    // replies[].sentAt is a Timestamp nested inside an array — serializeDoc only
    // converts top-level fields, so it needs its own conversion here.
    const replies = Array.isArray(data.replies)
      ? data.replies.map((r: any) => ({
          ...r,
          sentAt: r?.sentAt?.toDate ? r.sentAt.toDate().toISOString() : r.sentAt,
        }))
      : [];
    const repliesSummary = replies
      .map((r: any) => `[${r.sentAt || ""} by ${r.repliedBy || ""}] ${r.message || ""}`)
      .join(" || ");

    const line = csvLine([
      doc.id,
      capitalize(String(data.status ?? "")),
      String(data.name ?? ""),
      String(data.email ?? ""),
      String(data.subject ?? ""),
      String(data.message ?? ""),
      String(replies.length),
      repliesSummary,
      String(data.createdAt ?? ""),
      String(data.updatedAt ?? ""),
      String(cohortOf(data)),
    ]);
    return { sortKey: toSortKey(data.createdAt), line };
  });
  for (const line of contactLines) yield line;
  contactCount = contactLines.length;
  yield "";

  // ── SECTION 4: Brochure requests ────────────────────────────────────────────
  yield "SECTION 4 - BROCHURE REQUESTS";
  yield BROCHURE_COLUMNS.join(",");
  // No .orderBy() — same completeness reason as Section 1.
  const brochureStream = adminDb.collection("brochureRequests").stream();
  const brochureLines = await collectSorted(asDocStream(brochureStream), (doc) => {
    const data = serializeDoc(doc.data());
    if (cohort !== null && cohortOf(data) !== cohort) return null;
    const line = csvLine([
      doc.id,
      String(data.name ?? ""),
      String(data.email ?? ""),
      String(data.contact ?? ""),
      String(data.city ?? ""),
      String(data.ip ?? ""),
      String(data.createdAt ?? ""),
      String(data.updatedAt ?? ""),
      String(cohortOf(data)),
    ]);
    return { sortKey: toSortKey(data.createdAt), line };
  });
  for (const line of brochureLines) yield line;
  brochureCount = brochureLines.length;

  logInfo("api/applications/export", "CSV export completed", {
    applications: String(appCount),
    drafts:       String(draftCount),
    contacts:     String(contactCount),
    brochures:    String(brochureCount),
  });
}

// Groups individual CSV lines into larger chunks before they're handed to the
// HTTP stream — cuts the number of controller.enqueue() calls for very large
// exports while still never holding more than STREAM_BATCH_SIZE lines at once.
async function* batchLines(lines: AsyncGenerator<string>, batchSize: number): AsyncGenerator<string> {
  let buffer: string[] = [];
  for await (const line of lines) {
    buffer.push(line);
    if (buffer.length >= batchSize) {
      yield buffer.join("\r\n") + "\r\n";
      buffer = [];
    }
  }
  if (buffer.length) yield buffer.join("\r\n") + "\r\n";
}

// Bridges the async generator to a Web ReadableStream — pull() is only called
// when the consumer (the HTTP response, ultimately the client's download) is
// ready for more, so this is backpressure-aware end to end: client readiness
// gates our generator, which gates Firestore's own internal stream pacing.
function toResponseStream(lines: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await lines.next();
        if (done) { controller.close(); return; }
        controller.enqueue(encoder.encode(value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await lines.return(undefined);
    },
  });
}

// ─── GET /applications/export — admin: full CSV export, 4 sections ────────────
// Section 1 — fully submitted applications, tracked through
//   pending -> under_review -> interview_invited -> accepted/declined/cancelled,
//   plus payment/refund status.
// Section 2 — "applicationDrafts" that were never finalized: Step 1-5
//   in-progress or abandoned (24h+ inactive). A draft that WAS finalized is
//   skipped — its full data already appears in Section 1.
// Section 3 — every contact/message inquiry, including all admin replies.
// Section 4 — every brochure download request.
//
// The response streams to the client section by section (Firestore
// `.stream()` per collection + a Web ReadableStream) rather than loading
// every collection into memory and building one giant string first — each
// section is sorted newest-first in memory (see collectSorted()) but the
// client starts receiving Section 1 as soon as it's ready, without waiting
// for Sections 2-4 to finish reading.
export async function GET(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  // ?cohort=<n> exports one cohort only; omitted / "all" exports everything.
  const { cohort, invalid } = parseCohortFilter(new URL(request.url).searchParams.get("cohort"));
  if (invalid) {
    return NextResponse.json({ error: "cohort must be a positive integer or \"all\"" }, { status: 400, headers });
  }

  try {
    // Payments are only ever created for applications that reached "accepted" —
    // a small, bounded subset of all applicants — so loading this one
    // collection up front (rather than streaming it) is cheap and keeps the
    // per-application join simple. This read also happens BEFORE the response
    // is created, so a failure here still returns a normal error status; once
    // the stream below starts, headers are already committed and errors can
    // only end the stream early, not change the HTTP status.
    const paymentsSnap = await adminDb.collection("payments").get();
    const paymentsById = new Map<string, Record<string, any>>();
    for (const doc of paymentsSnap.docs) {
      paymentsById.set(doc.id, serializeDoc(doc.data()));
    }

    const body = toResponseStream(batchLines(generateRows(paymentsById, cohort), STREAM_BATCH_SIZE));
    const filename = `dealschool-export${cohort ? `-cohort-${cohort}` : ""}-${new Date().toISOString().slice(0, 10)}.csv`;

    return new NextResponse(body, {
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


