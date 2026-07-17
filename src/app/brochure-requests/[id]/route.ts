import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { logInfo, logWarn } from "@/lib/logger";

export const runtime = "nodejs";

// ─── DELETE /brochure-requests/[id] — admin: delete ────────────────────────────
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  logInfo("api/brochure-requests/[id]", "DELETE received", { id });

  try { await verifyAdmin(request); }
  catch {
    logWarn("api/brochure-requests/[id]", "Unauthorized DELETE attempt", { id });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  const docRef = adminDb.collection("brochureRequests").doc(id);
  const snap   = await docRef.get();
  if (!snap.exists) {
    logWarn("api/brochure-requests/[id]", "Brochure request not found", { id });
    return NextResponse.json({ error: "Brochure request not found" }, { status: 404, headers });
  }

  await docRef.delete();
  logInfo("api/brochure-requests/[id]", "DELETE 200 — brochure request deleted", { id });
  return NextResponse.json({ success: true }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
