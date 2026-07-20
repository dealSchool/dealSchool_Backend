import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { logInfo, logError } from "@/lib/logger";
import { submitApplication } from "@/lib/application-service";

export const runtime = "nodejs";

// ─── POST /applications/draft/[draftId]/submit — public: finalize a draft ─────
// Body: the Step 5 fields (resumeUrl/resumeLink, discoverySource, discoverySourceOther).
// Merges them onto the draft's accumulated formData and runs it through the
// same validation/dedup/email path as a direct POST /applications submit.
export async function POST(request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const { draftId } = await params;

  let finalFields: any;
  try { finalFields = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  try {
    const docRef = adminDb.collection("applicationDrafts").doc(draftId);
    const snap   = await docRef.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404, headers });
    }

    const draft = snap.data()!;
    if (draft.status === "submitted") {
      return NextResponse.json({ success: true, applicationId: draft.applicationId }, { headers });
    }

    const merged = { ...draft.formData, ...finalFields };
    const result = await submitApplication(merged);
    if (!result.ok) {
      return NextResponse.json(result.body, { status: result.status, headers });
    }

    await docRef.update({
      status:        "submitted",
      applicationId: result.applicationId,
      updatedAt:     FieldValue.serverTimestamp(),
    });

    logInfo("api/applications/draft/[draftId]/submit", "Draft finalized into application", { draftId, applicationId: result.applicationId });
    return NextResponse.json({ success: true, applicationId: result.applicationId }, { status: 201, headers });
  } catch (err) {
    logError("api/applications/draft/[draftId]/submit", "POST unhandled error", err);
    return NextResponse.json({ error: "Internal server error. Please try again." }, { status: 500, headers });
  }
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
