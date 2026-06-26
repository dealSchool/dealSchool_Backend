import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";

export const runtime = "nodejs";

// ─── PATCH /api/contacts/[id] — admin: update status / notes ─────────────────
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  const docRef = adminDb.collection("contacts").doc(id);
  const snap   = await docRef.get();

  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404, headers });
  }

  const updatePayload: Record<string, any> = {
    ...body,
    updatedAt: FieldValue.serverTimestamp(),
  };
  delete updatePayload.id;
  delete updatePayload.createdAt;

  await docRef.update(updatePayload);

  // Build response from known data — avoids an extra Firestore read.
  // Replace the FieldValue sentinel in updatedAt with a real ISO string.
  const prevData = snap.data()!;
  const responsePayload = { ...updatePayload, updatedAt: new Date().toISOString() };
  const merged = serializeDoc({ ...prevData, ...responsePayload });
  return NextResponse.json(
    { success: true, contact: { id, ...merged } },
    { headers }
  );
}

// ─── DELETE /api/contacts/[id] — admin: delete ───────────────────────────────
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try { await verifyAdmin(request); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }); }

  const snap = await adminDb.collection("contacts").doc(id).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404, headers });
  }

  await adminDb.collection("contacts").doc(id).delete();
  return NextResponse.json({ success: true }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
