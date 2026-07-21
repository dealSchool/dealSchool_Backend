import { NextRequest, NextResponse } from "next/server";
import { FieldValue, Filter } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { isValidEmail, sanitizeHeader } from "@/lib/validate";

export const runtime = "nodejs";

const PAGE_SIZE = 50;

const ALREADY_APPLIED_MSG =
  "You've already applied to DealSchool. Our team will reach out to you shortly. For any queries, contact support@dealschool.in";

// First-page results (list + per-step counts) are hit by dashboard polling
// far more often than drafts actually change, so they're cached in memory
// for a short TTL — same pattern as cohort-settings.ts/payment-mode-settings.ts.
const LIST_CACHE_TTL_MS = 60 * 1000;
const listCache = new Map<number, { body: unknown; expiresAt: number }>();

// ─── GET /applications/draft — admin: paginated list of abandoned drafts ──────
export async function GET(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  const { searchParams } = new URL(request.url);
  const limit       = Math.min(parseInt(searchParams.get("limit") || String(PAGE_SIZE)), 100);
  const after       = searchParams.get("after");
  const isFirstPage = !after;

  if (isFirstPage) {
    const hit = listCache.get(limit);
    if (hit && Date.now() < hit.expiresAt) {
      return NextResponse.json(hit.body, { headers });
    }
  }

  let query = adminDb
    .collection("applicationDrafts")
    .where("status", "==", "in_progress")
    .orderBy("updatedAt", "desc")
    .limit(limit + 1);

  if (after) {
    const cursorSnap = await adminDb.collection("applicationDrafts").doc(after).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }

  const countQueries = isFirstPage
    ? [1, 2, 3, 4, 5].map((step) =>
        adminDb
          .collection("applicationDrafts")
          .where("status", "==", "in_progress")
          .where("currentStep", "==", step)
          .count()
          .get()
      )
    : [];

  const [snapshot, ...countSnaps] = await Promise.all([query.get(), ...countQueries]);

  const hasMore    = snapshot.docs.length > limit;
  const docs       = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;

  // A draft has no explicit "abandoned" status in Firestore — it just sits at
  // "in_progress" forever. Derive a label from inactivity instead of adding a
  // cron job to flip a stored field.
  const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000; // 24h since last step saved
  const now = Date.now();
  const drafts = docs.map((d) => {
    const data      = serializeDoc(d.data());
    const updatedAt = data.updatedAt ? new Date(data.updatedAt).getTime() : now;
    const label     = now - updatedAt > ABANDONED_AFTER_MS ? "abandoned" : "in_progress";
    return { id: d.id, ...data, label };
  });
  const nextCursor = hasMore ? docs[docs.length - 1].id : null;

  const counts = isFirstPage
    ? { step1: (countSnaps[0] as any).data().count,
        step2: (countSnaps[1] as any).data().count,
        step3: (countSnaps[2] as any).data().count,
        step4: (countSnaps[3] as any).data().count,
        step5: (countSnaps[4] as any).data().count }
    : undefined;

  const body = { drafts, hasMore, nextCursor, counts };
  if (isFirstPage) {
    listCache.set(limit, { body, expiresAt: Date.now() + LIST_CACHE_TTL_MS });
  }
  return NextResponse.json(body, { headers });
}

// ─── POST /applications/draft — public: create/resume a draft after Step 1 ────
// Body: { fullName, mobileNumber, email, linkedinUrl?, city? }
// Upserts by mobileNumber so re-submitting Step 1 in the same session doesn't
// create duplicate drafts.
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const ip      = getClientIp(request);

  const rl = await checkRateLimit(`apply-draft:${ip}`, 20, 15 * 60 * 1000);
  if (!rl.allowed) {
    logWarn("api/applications/draft", "Rate limited", { ip });
    return NextResponse.json(
      { error: "Too many requests. Please wait before trying again." },
      { status: 429, headers: { ...headers, "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  let data: any;
  try { data = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  const required = ["fullName", "mobileNumber", "email"];
  const missing  = required.filter((f) => !data[f]);
  if (missing.length) {
    return NextResponse.json({ error: `Missing fields: ${missing.join(", ")}` }, { status: 400, headers });
  }

  if (!isValidEmail(String(data.email))) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400, headers });
  }

  const email       = sanitizeHeader(String(data.email)).toLowerCase();
  const mobileNumber = sanitizeHeader(String(data.mobileNumber));
  const fullName    = sanitizeHeader(String(data.fullName));
  const city        = data.city ? sanitizeHeader(String(data.city)) : "";
  const linkedinUrl = data.linkedinUrl ? sanitizeHeader(String(data.linkedinUrl)) : "";

  try {
    // Someone who already fully applied shouldn't be routed into a fresh draft.
    const appDupSnap = await adminDb
      .collection("applications")
      .where(Filter.or(
        Filter.where("email", "==", email),
        Filter.where("mobileNumber", "==", mobileNumber),
      ))
      .limit(1)
      .get();
    if (!appDupSnap.empty) {
      return NextResponse.json({ alreadyApplied: true, error: ALREADY_APPLIED_MSG }, { status: 409, headers });
    }

    const step1Fields = { fullName, mobileNumber, email, linkedinUrl, city };
    const draftsRef   = adminDb.collection("applicationDrafts");

    // Runs the existing-draft check and the create/update inside one transaction —
    // a plain query-then-write here let two near-simultaneous Step 1 submits (double
    // click, flaky network retry) both see "no existing draft" and both create one,
    // producing duplicate in_progress drafts for the same phone+email. Firestore
    // re-validates the query on commit, so a concurrent write forces this to retry
    // and see the just-created draft instead of creating a second one.
    const result = await adminDb.runTransaction(async (t) => {
      const existingQuery = draftsRef
        .where("mobileNumber", "==", mobileNumber)
        .where("status", "==", "in_progress")
        .limit(1);
      const existingSnap = await t.get(existingQuery);

      if (!existingSnap.empty) {
        const existingDoc = existingSnap.docs[0];
        const existing    = existingDoc.data();
        t.update(existingDoc.ref, {
          formData:  { ...existing.formData, ...step1Fields },
          email,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return { draftId: existingDoc.id, currentStep: existing.currentStep as number, resumed: true, isNew: false };
      }

      const docRef = draftsRef.doc();
      t.set(docRef, {
        mobileNumber,
        email,
        currentStep: 1,
        formData:  step1Fields,
        status:    "in_progress",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { draftId: docRef.id, currentStep: 1, resumed: false, isNew: true };
    });

    logInfo(
      "api/applications/draft",
      result.isNew ? "Draft created" : "Draft resumed on Step 1 resubmit",
      { draftId: result.draftId }
    );
    return NextResponse.json(
      { draftId: result.draftId, currentStep: result.currentStep, resumed: result.resumed },
      { status: result.isNew ? 201 : 200, headers }
    );
  } catch (err) {
    logError("api/applications/draft", "POST unhandled error", err);
    return NextResponse.json({ error: "Internal server error. Please try again." }, { status: 500, headers });
  }
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
