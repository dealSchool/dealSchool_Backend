import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { sendEmail } from "@/lib/mailer";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { isValidEmail, sanitizeHeader } from "@/lib/validate";
import { renderContactInquiryAdmin, renderContactInquiryCandidate } from "@/lib/email-templates";

export const runtime = "nodejs";

const CONTACT_SENDER = "DealSchool HelpDesk <support@dealschool.in>";

const PAGE_SIZE = 50;

// ─── GET /api/contacts — admin: paginated list ────────────────────────────────
// Query params: ?limit=50&after=<docId>
// First page response also includes aggregate counts for the dashboard metrics.
export async function GET(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  const { searchParams } = new URL(request.url);
  const limit      = Math.min(parseInt(searchParams.get("limit") || String(PAGE_SIZE)), 100);
  const after      = searchParams.get("after");
  const isFirstPage = !after;

  let query = adminDb
    .collection("contacts")
    .orderBy("createdAt", "desc")
    .limit(limit + 1);

  if (after) {
    const cursorSnap = await adminDb.collection("contacts").doc(after).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }

  const countQueries = isFirstPage
    ? [
        adminDb.collection("contacts").where("status", "==", "unread").count().get(),
        adminDb.collection("contacts").where("status", "==", "read").count().get(),
        adminDb.collection("contacts").where("status", "==", "archived").count().get(),
      ]
    : [];

  const [snapshot, ...countSnaps] = await Promise.all([query.get(), ...countQueries]);

  const hasMore   = snapshot.docs.length > limit;
  const docs      = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;
  const contacts  = docs.map((d) => ({ id: d.id, ...serializeDoc(d.data()) }));
  const nextCursor = hasMore ? docs[docs.length - 1].id : null;

  const counts = isFirstPage
    ? {
        unread:   (countSnaps[0] as any).data().count,
        read:     (countSnaps[1] as any).data().count,
        archived: (countSnaps[2] as any).data().count,
      }
    : undefined;

  return NextResponse.json({ contacts, hasMore, nextCursor, counts }, { headers });
}

// ─── POST /api/contacts — public: submit contact inquiry + send emails ────────
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const ip      = getClientIp(request);
  logInfo("api/contacts", "POST received", { ip, origin: origin ?? "none" });

  try {
    // Rate limit: 5 submissions per 15 minutes per IP
    const rl = await checkRateLimit(`contact:${ip}`, 5, 15 * 60 * 1000);
    if (!rl.allowed) {
      logWarn("api/contacts", "Rate limited", { ip });
      return NextResponse.json(
        { error: "Too many requests. Please wait before submitting again." },
        { status: 429, headers: { ...headers, "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }

    let data: any;
    try { data = await request.json(); }
    catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

    const { name, email, subject, message } = data;
    if (!name || !email || !subject || !message) {
      return NextResponse.json(
        { error: "name, email, subject, and message are required" },
        { status: 400, headers }
      );
    }

    // Validate email — prevents injection of multiple recipients
    if (!isValidEmail(String(email))) {
      return NextResponse.json({ error: "Invalid email address" }, { status: 400, headers });
    }

    // Sanitize fields used in email headers to prevent SMTP header injection
    const safeName    = sanitizeHeader(String(name));
    const safeEmail   = sanitizeHeader(String(email)).toLowerCase();
    const safeSubject = sanitizeHeader(String(subject));
    const safeMessage = String(message).slice(0, 5000); // cap message length

    // Reject duplicate inquiries from the same email within 1 hour.
    // Uses a single-field equality query only (auto-indexed, no composite index required).
    // createdAt comparison is done in memory to avoid needing a composite index.
    const byEmailSnap = await adminDb
      .collection("contacts")
      .where("email", "==", safeEmail)
      .get();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const hasRecentSubmission = byEmailSnap.docs.some((d) => {
      const ts = d.data().createdAt;
      const ms = ts?.toMillis ? ts.toMillis() : ts instanceof Date ? ts.getTime() : 0;
      return ms >= oneHourAgo;
    });
    if (hasRecentSubmission) {
      return NextResponse.json(
        { error: "A message from this email was already submitted recently. Please wait an hour before sending again." },
        { status: 409, headers }
      );
    }

    const docRef = adminDb.collection("contacts").doc();
    await docRef.set({
      name:      safeName,
      email:     safeEmail,
      subject:   safeSubject,
      message:   safeMessage,
      status:    "unread",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const adminEmail = process.env.ADMIN_EMAIL || "support@dealschool.in";
    logInfo("api/contacts", "Contact saved to Firestore", { contactId: docRef.id, senderEmail: safeEmail });

    sendEmail({
      from:    CONTACT_SENDER,
      to:      adminEmail,
      subject: `[Inquiry Ticket] From ${safeName}: ${safeSubject}`,
      html:    renderContactInquiryAdmin({ name: safeName, email: safeEmail, subject: safeSubject, message: safeMessage }),
    }).catch((err) => logError("api/contacts", `Admin notification email FAILED contactId=${docRef.id} adminEmail=${adminEmail}`, err));

    sendEmail({
      from:    CONTACT_SENDER,
      to:      safeEmail,
      subject: "We Received Your Message | DealSchool",
      html:    renderContactInquiryCandidate({ name: safeName, subject: safeSubject, message: safeMessage }),
    }).catch((err) => logError("api/contacts", `Sender confirmation email FAILED contactId=${docRef.id} senderEmail=${safeEmail}`, err));

    logInfo("api/contacts", "POST 201 completed", { contactId: docRef.id });
    return NextResponse.json({ success: true, contactId: docRef.id }, { status: 201, headers });
  } catch (err: any) {
    logError("api/contacts", "POST unhandled error", err);
    return NextResponse.json({ error: "Internal server error. Please try again." }, { status: 500, headers });
  }
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
