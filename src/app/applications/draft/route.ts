import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { logInfo, logWarn } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { isValidEmail, sanitizeHeader } from "@/lib/validate";

export const runtime = "nodejs";

const PAGE_SIZE = 50;

const ALREADY_APPLIED_MSG =
  "You've already applied to DealSchool. Our team will reach out to you shortly. For any queries, contact support@dealschool.in";

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

  return NextResponse.json({ drafts, hasMore, nextCursor, counts }, { headers });
}

// ─── POST /applications/draft — public: create/resume a draft after Step 1 ────
// Body: { fullName, mobileNumber, email, linkedinUrl?, city }
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

  const required = ["fullName", "mobileNumber", "email", "city"];
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
  const city        = sanitizeHeader(String(data.city));
  const linkedinUrl = data.linkedinUrl ? sanitizeHeader(String(data.linkedinUrl)) : "";

  // Someone who already fully applied shouldn't be routed into a fresh draft.
  const [appEmailSnap, appPhoneSnap] = await Promise.all([
    adminDb.collection("applications").where("email", "==", email).limit(1).get(),
    adminDb.collection("applications").where("mobileNumber", "==", mobileNumber).limit(1).get(),
  ]);
  if (!appEmailSnap.empty || !appPhoneSnap.empty) {
    return NextResponse.json({ alreadyApplied: true, error: ALREADY_APPLIED_MSG }, { status: 409, headers });
  }

  const step1Fields = { fullName, mobileNumber, email, linkedinUrl, city };

  const existingSnap = await adminDb
    .collection("applicationDrafts")
    .where("mobileNumber", "==", mobileNumber)
    .where("status", "==", "in_progress")
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    const existingDoc = existingSnap.docs[0];
    const existing    = existingDoc.data();
    await existingDoc.ref.update({
      formData:  { ...existing.formData, ...step1Fields },
      email,
      updatedAt: FieldValue.serverTimestamp(),
    });
    logInfo("api/applications/draft", "Draft resumed on Step 1 resubmit", { draftId: existingDoc.id });
    return NextResponse.json(
      { draftId: existingDoc.id, currentStep: existing.currentStep, resumed: true },
      { headers }
    );
  }

  const docRef = adminDb.collection("applicationDrafts").doc();
  await docRef.set({
    mobileNumber,
    email,
    currentStep: 1,
    formData:  step1Fields,
    status:    "in_progress",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  logInfo("api/applications/draft", "Draft created", { draftId: docRef.id });
  return NextResponse.json({ draftId: docRef.id, currentStep: 1, resumed: false }, { status: 201, headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
