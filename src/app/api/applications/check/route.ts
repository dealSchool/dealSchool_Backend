import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { isValidEmail } from "@/lib/validate";
import { logInfo, logWarn } from "@/lib/logger";

export const runtime = "nodejs";

const ALREADY_APPLIED_MSG =
  "You've already applied to DealSchool. Our team will reach out to you shortly. For any queries, contact support@dealschool.in";

// POST /api/applications/check
// Public — call on email/phone field blur to show early feedback.
// Body: { email?: string, phone?: string }  (at least one required)
// Response: { alreadyApplied: boolean, message?: string }
export async function POST(request: NextRequest) {
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);

  let body: any;
  try { body = await request.json(); }
  catch {
    logWarn("api/applications/check", "Invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
  const phone = typeof body.phone === "string" ? body.phone.trim() : null;

  if (!email && !phone) {
    return NextResponse.json(
      { error: "Provide at least one of: email, phone" },
      { status: 400, headers }
    );
  }

  if (email && !isValidEmail(email)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400, headers });
  }

  const queries: Promise<FirebaseFirestore.QuerySnapshot>[] = [];
  if (email) queries.push(adminDb.collection("applications").where("email", "==", email).limit(1).get());
  if (phone) queries.push(adminDb.collection("applications").where("mobileNumber", "==", phone).limit(1).get());

  const snaps = await Promise.all(queries);
  const alreadyApplied = snaps.some((s) => !s.empty);

  logInfo("api/applications/check", "Duplicate check completed", { email: email ?? "none", phone: phone ?? "none", alreadyApplied: String(alreadyApplied) });

  return NextResponse.json(
    alreadyApplied
      ? { alreadyApplied: true, message: ALREADY_APPLIED_MSG }
      : { alreadyApplied: false },
    { headers }
  );
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
