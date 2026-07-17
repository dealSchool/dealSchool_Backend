import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { logInfo, logWarn } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

// ─── PATCH /applications/draft/[draftId] — public: save a step's fields ───────
// Body: { step: number, fields: Record<string, unknown> }
// Merges `fields` into the draft's accumulated formData and advances currentStep.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const ip      = getClientIp(request);
  const { draftId } = await params;

  const rl = await checkRateLimit(`apply-draft-patch:${ip}`, 60, 15 * 60 * 1000);
  if (!rl.allowed) {
    logWarn("api/applications/draft/[draftId]", "Rate limited", { ip });
    return NextResponse.json(
      { error: "Too many requests. Please wait before trying again." },
      { status: 429, headers: { ...headers, "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  const step   = Number(body.step);
  const fields = body.fields;
  if (!Number.isInteger(step) || step < 1 || step > 5 || typeof fields !== "object" || fields === null) {
    return NextResponse.json({ error: "step (1-5) and fields (object) are required" }, { status: 400, headers });
  }

  // Cap payload size — a step's form fields are always small; this only guards against abuse.
  if (JSON.stringify(fields).length > 20_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers });
  }

  const docRef = adminDb.collection("applicationDrafts").doc(draftId);
  const snap   = await docRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404, headers });
  }

  const draft = snap.data()!;
  if (draft.status !== "in_progress") {
    return NextResponse.json({ error: "This application has already been submitted" }, { status: 409, headers });
  }

  const currentStep = Math.max(draft.currentStep || 1, step);
  await docRef.update({
    formData:    { ...draft.formData, ...fields },
    currentStep,
    updatedAt:   FieldValue.serverTimestamp(),
  });

  logInfo("api/applications/draft/[draftId]", "Draft step saved", { draftId, step });
  return NextResponse.json({ success: true, currentStep }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
