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
import { LIST_CACHE_TTL_MS, listCache, invalidateBrochureRequestsListCache } from "@/lib/brochure-requests-cache";
import { cohortOf, getActiveCohortNumber, listCacheKey, parseCohortFilter } from "@/lib/cohort-settings";

export const runtime = "nodejs";

const ADMIN_SENDER = "DealSchool <support@dealschool.in>";

const PAGE_SIZE = 50;

// ─── GET /brochure-requests — admin: paginated list ───────────────────────────
// Query params: ?limit=50&after=<docId>&cohort=<n|all>
// `cohort` scopes the list and total to one cohort; omitted = all cohorts.
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

  const { cohort, invalid } = parseCohortFilter(searchParams.get("cohort"));
  if (invalid) {
    return NextResponse.json({ error: "cohort must be a positive integer or \"all\"" }, { status: 400, headers });
  }
  const cacheKey = listCacheKey(limit, cohort);

  if (isFirstPage) {
    const hit = listCache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt) {
      return NextResponse.json(hit.body, { headers });
    }
  }

  const scoped = (): FirebaseFirestore.Query => {
    const col = adminDb.collection("brochureRequests");
    return cohort ? col.where("cohort", "==", cohort) : col;
  };

  let query = scoped()
    .orderBy("createdAt", "desc")
    .limit(limit + 1); // +1 to detect hasMore without an extra query

  if (after) {
    const cursorSnap = await adminDb.collection("brochureRequests").doc(after).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }

  const [snapshot, totalSnap] = await Promise.all([
    query.get(),
    isFirstPage ? scoped().count().get() : Promise.resolve(null),
  ]);

  const hasMore     = snapshot.docs.length > limit;
  const docs        = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;
  const requests    = docs.map((d) => ({ id: d.id, ...serializeDoc(d.data()), cohort: cohortOf(d.data()) }));
  const nextCursor  = hasMore ? docs[docs.length - 1].id : null;
  const total       = totalSnap ? (totalSnap as any).data().count : undefined;

  const body = { requests, hasMore, nextCursor, total };
  if (isFirstPage) {
    listCache.set(cacheKey, { body, expiresAt: Date.now() + LIST_CACHE_TTL_MS });
  }
  return NextResponse.json(body, { headers });
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

    // New requests are stamped with the cohort active right now (server-side,
    // never from the request body).
    const activeCohort = await getActiveCohortNumber();

    // Skip saving if this exact email + contact combination already requested a
    // brochure in THIS cohort — a repeat request in a later cohort is a fresh
    // lead for that cohort and gets its own record, so earlier cohorts' counts
    // stay intact. Filtered in memory so legacy records with no `cohort` field
    // still count as Cohort 1.
    const dupSnap = await adminDb
      .collection("brochureRequests")
      .where("email", "==", safeEmail)
      .where("contact", "==", safeContact)
      .limit(20)
      .get();
    const sameCohortDup = dupSnap.docs.find((d) => cohortOf(d.data()) === activeCohort);

    if (sameCohortDup) {
      const existingDoc = sameCohortDup;
      // Renewed interest — someone downloading the brochure again after already
      // going quiet (or having exhausted all 3 nudges) should re-enter the
      // reminder sequence from the top rather than staying stuck wherever the
      // old request left off. createdAt drives runBrochureReminder's age
      // threshold, so it resets too — this request is the one that should
      // count for timing purposes now.
      await existingDoc.ref.update({
        reminderStage: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      invalidateBrochureRequestsListCache();
      logInfo("api/brochure-requests", "Duplicate brochure request — reminder sequence reset", { requestId: existingDoc.id, email: safeEmail });
      return NextResponse.json({ success: true, requestId: existingDoc.id, duplicate: true }, { status: 200, headers });
    }

    const docRef = adminDb.collection("brochureRequests").doc();
    await docRef.set({
      cohort:    activeCohort,
      name:      safeName,
      contact:   safeContact,
      email:     safeEmail,
      city:      safeCity,
      ip,
      reminderStage: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    invalidateBrochureRequestsListCache();
    logInfo("api/brochure-requests", "Brochure request saved to Firestore", { requestId: docRef.id, email: safeEmail });

    const adminEmail = process.env.NOTIFICATION_EMAIL || "support@dealschool.in";
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
