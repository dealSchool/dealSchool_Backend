import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { submitApplication } from "@/lib/application-service";
import { LIST_CACHE_TTL_MS, listCache } from "@/lib/applications-cache";
import { parseCohortFilter, listCacheKey, cohortOf } from "@/lib/cohort-settings";

export const runtime = "nodejs";

const PAGE_SIZE = 50;

// ─── GET /applications — admin: paginated list ────────────────────────────────
// Query params: ?limit=50&after=<docId>&cohort=<n|all>
// `cohort` scopes both the list and the counts to one cohort; omitted = all cohorts.
// First page response also includes aggregate counts so the dashboard metrics
// stay accurate without a separate API call.
export async function GET(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  const { searchParams } = new URL(request.url);
  const limit      = Math.min(parseInt(searchParams.get("limit") || String(PAGE_SIZE)), 100);
  const after      = searchParams.get("after");
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
    const col = adminDb.collection("applications");
    return cohort ? col.where("cohort", "==", cohort) : col;
  };

  let query = scoped()
    .orderBy("createdAt", "desc")
    .limit(limit + 1); // +1 to detect hasMore without an extra query

  if (after) {
    const cursorSnap = await adminDb.collection("applications").doc(after).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }

  // Run page fetch + count aggregations in parallel (counts only on first page)
  const countQueries = isFirstPage
    ? [
        scoped().where("status", "==", "pending").count().get(),
        scoped().where("status", "==", "under_review").count().get(),
        scoped().where("status", "==", "interview_invited").count().get(),
        scoped().where("status", "==", "interview_completed").count().get(),
        scoped().where("status", "==", "accepted").count().get(),
        scoped().where("status", "==", "declined").count().get(),
        scoped().where("status", "==", "cancelled").count().get(),
        scoped().where("paymentStatus", "==", "paid").count().get(),
      ]
    : [];

  const [snapshot, ...countSnaps] = await Promise.all([query.get(), ...countQueries]);

  const hasMore    = snapshot.docs.length > limit;
  const docs       = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;
  const applications = docs.map((d) => ({ id: d.id, ...serializeDoc(d.data()), cohort: cohortOf(d.data()) }));
  const nextCursor = hasMore ? docs[docs.length - 1].id : null;

  // Every status the "applications" collection can hold must be counted here —
  // the admin dashboard sums these into a grand total for its tab badge and
  // pagination page count, so a missing status silently undercounts both.
  // `paid` tracks the separate `paymentStatus` field (set only by the Cashfree
  // webhook) rather than `status` — an application can be `status: "accepted"`
  // without being paid yet, so this can't be derived from the values above.
  const counts = isFirstPage
    ? {
        pending:             (countSnaps[0] as any).data().count,
        under_review:        (countSnaps[1] as any).data().count,
        interview_invited:   (countSnaps[2] as any).data().count,
        interview_completed: (countSnaps[3] as any).data().count,
        accepted:            (countSnaps[4] as any).data().count,
        declined:            (countSnaps[5] as any).data().count,
        cancelled:           (countSnaps[6] as any).data().count,
        paid:                (countSnaps[7] as any).data().count,
      }
    : undefined;

  const body = { applications, hasMore, nextCursor, counts };
  if (isFirstPage) {
    listCache.set(cacheKey, { body, expiresAt: Date.now() + LIST_CACHE_TTL_MS });
  }
  return NextResponse.json(body, { headers });
}

// ─── POST /applications — public: submit new application ─────────────────────
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const ip      = getClientIp(request);
  logInfo("api/applications", "POST received", { ip, origin: origin ?? "none" });

  const rl = await checkRateLimit(`apply:${ip}`, 5, 15 * 60 * 1000);
  if (!rl.allowed) {
    logWarn("api/applications", "Rate limited", { ip });
    return NextResponse.json(
      { error: "Too many requests. Please wait before submitting again." },
      { status: 429, headers: { ...headers, "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  let data: any;
  try { data = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  try {
    const result = await submitApplication(data);
    if (!result.ok) {
      return NextResponse.json(result.body, { status: result.status, headers });
    }

    logInfo("api/applications", "POST 201 completed", { applicationId: result.applicationId });
    return NextResponse.json({ success: true, applicationId: result.applicationId }, { status: 201, headers });
  } catch (err) {
    logError("api/applications", "POST unhandled error", err);
    return NextResponse.json({ error: "Internal server error. Please try again." }, { status: 500, headers });
  }
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
