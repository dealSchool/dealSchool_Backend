import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { logInfo, logWarn } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { submitApplication } from "@/lib/application-service";

export const runtime = "nodejs";

const PAGE_SIZE = 50;

// ─── GET /applications — admin: paginated list ────────────────────────────────
// Query params: ?limit=50&after=<docId>
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

  let query = adminDb
    .collection("applications")
    .orderBy("createdAt", "desc")
    .limit(limit + 1); // +1 to detect hasMore without an extra query

  if (after) {
    const cursorSnap = await adminDb.collection("applications").doc(after).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }

  // Run page fetch + count aggregations in parallel (counts only on first page)
  const countQueries = isFirstPage
    ? [
        adminDb.collection("applications").where("status", "==", "pending").count().get(),
        adminDb.collection("applications").where("status", "==", "under_review").count().get(),
        adminDb.collection("applications").where("status", "==", "interview_invited").count().get(),
        adminDb.collection("applications").where("status", "==", "accepted").count().get(),
        adminDb.collection("applications").where("status", "==", "declined").count().get(),
      ]
    : [];

  const [snapshot, ...countSnaps] = await Promise.all([query.get(), ...countQueries]);

  const hasMore    = snapshot.docs.length > limit;
  const docs       = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;
  const applications = docs.map((d) => ({ id: d.id, ...serializeDoc(d.data()) }));
  const nextCursor = hasMore ? docs[docs.length - 1].id : null;

  const counts = isFirstPage
    ? {
        pending:           (countSnaps[0] as any).data().count,
        under_review:      (countSnaps[1] as any).data().count,
        interview_invited: (countSnaps[2] as any).data().count,
        accepted:          (countSnaps[3] as any).data().count,
        declined:          (countSnaps[4] as any).data().count,
      }
    : undefined;

  return NextResponse.json({ applications, hasMore, nextCursor, counts }, { headers });
}

// ─── POST /applications — public: submit new application ─────────────────────
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const ip      = getClientIp(request);
  logInfo("api/applications", "POST received", { ip, origin: origin ?? "none" });

  // Rate limit: 5 submissions per 15 minutes per IP
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

  const result = await submitApplication(data);
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status, headers });
  }

  logInfo("api/applications", "POST 201 completed", { applicationId: result.applicationId });
  return NextResponse.json({ success: true, applicationId: result.applicationId }, { status: 201, headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
