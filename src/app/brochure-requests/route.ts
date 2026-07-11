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
import { renderBrochureRequestAdmin } from "@/lib/email-templates";

export const runtime = "nodejs";

const ADMIN_SENDER = "DealSchool <support@dealschool.in>";

const PAGE_SIZE = 50;

// ─── GET /brochure-requests — admin: paginated list ───────────────────────────
// Query params: ?limit=50&after=<docId>
// First page response also includes the total request count for the dashboard.
export async function GET(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  const { searchParams } = new URL(request.url);
  const limit       = Math.min(parseInt(searchParams.get("limit") || String(PAGE_SIZE)), 100);
  const after       = searchParams.get("after");
  const isFirstPage = !after;

  let query = adminDb
    .collection("brochureRequests")
    .orderBy("createdAt", "desc")
    .limit(limit + 1); // +1 to detect hasMore without an extra query

  if (after) {
    const cursorSnap = await adminDb.collection("brochureRequests").doc(after).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }

  const [snapshot, totalSnap] = await Promise.all([
    query.get(),
    isFirstPage ? adminDb.collection("brochureRequests").count().get() : Promise.resolve(null),
  ]);

  const hasMore     = snapshot.docs.length > limit;
  const docs        = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;
  const requests    = docs.map((d) => ({ id: d.id, ...serializeDoc(d.data()) }));
  const nextCursor  = hasMore ? docs[docs.length - 1].id : null;
  const total       = totalSnap ? (totalSnap as any).data().count : undefined;

  return NextResponse.json({ requests, hasMore, nextCursor, total }, { headers });
}

// ─── POST /brochure-requests — public: capture brochure download lead ─────────
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const ip      = getClientIp(request);
  logInfo("api/brochure-requests", "POST received", { ip, origin: origin ?? "none" });

  try {
    // Rate limit: 10 submissions per 15 minutes per IP
    const rl = await checkRateLimit(`brochure:${ip}`, 10, 15 * 60 * 1000);
    if (!rl.allowed) {
      logWarn("api/brochure-requests", "Rate limited", { ip });
      return NextResponse.json(
        { error: "Too many requests. Please wait before submitting again." },
        { status: 429, headers: { ...headers, "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }

    let data: any;
    try { data = await request.json(); }
    catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

    const { name, contact, email, city } = data;
    if (!name || !contact || !email || !city) {
      return NextResponse.json(
        { error: "name, contact, email, and city are required" },
        { status: 400, headers }
      );
    }

    // Validate email format — prevents injection of multiple recipients
    if (!isValidEmail(String(email))) {
      return NextResponse.json({ error: "Invalid email address" }, { status: 400, headers });
    }

    // Basic sanity check on the contact number — 7 to 15 digits, ignoring formatting
    const digitsOnly = String(contact).replace(/\D/g, "");
    if (digitsOnly.length < 7 || digitsOnly.length > 15) {
      return NextResponse.json({ error: "Invalid contact number" }, { status: 400, headers });
    }

    // Sanitize fields used in email headers to prevent SMTP header injection
    const safeName    = sanitizeHeader(String(name)).slice(0, 200);
    const safeContact = sanitizeHeader(String(contact)).slice(0, 20);
    const safeEmail   = sanitizeHeader(String(email)).toLowerCase().slice(0, 200);
    const safeCity    = sanitizeHeader(String(city)).slice(0, 100);

    const docRef = adminDb.collection("brochureRequests").doc();
    await docRef.set({
      name:      safeName,
      contact:   safeContact,
      email:     safeEmail,
      city:      safeCity,
      ip,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    logInfo("api/brochure-requests", "Brochure request saved to Firestore", { requestId: docRef.id, email: safeEmail });

    const adminEmail = process.env.ADMIN_EMAIL || "support@dealschool.in";
    sendEmail({
      from:    ADMIN_SENDER,
      to:      adminEmail,
      subject: `[Brochure Request] ${safeName} — ${safeCity}`,
      html:    renderBrochureRequestAdmin({ name: safeName, email: safeEmail, contact: safeContact, city: safeCity }),
    }).catch((err) => logError("api/brochure-requests", `Admin notification email FAILED requestId=${docRef.id} adminEmail=${adminEmail}`, err));

    logInfo("api/brochure-requests", "POST 201 completed", { requestId: docRef.id });
    return NextResponse.json({ success: true, requestId: docRef.id }, { status: 201, headers });
  } catch (err: any) {
    logError("api/brochure-requests", "POST unhandled error", err);
    return NextResponse.json({ error: "Internal server error. Please try again." }, { status: 500, headers });
  }
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
