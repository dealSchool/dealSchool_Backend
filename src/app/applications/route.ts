import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { sendEmail } from "@/lib/mailer";
import { logInfo, logError, logWarn } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { isValidEmail, sanitizeHeader } from "@/lib/validate";
import {
  renderAppReceivedCandidate,
  renderAppReceivedAdmin,
} from "@/lib/email-templates";

export const runtime = "nodejs";

const CANDIDATE_SENDER = "DealSchool <support@dealschool.in>";
const ADMIN_SENDER     = "DealSchool <support@dealschool.in>";

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

  const required = ["fullName", "email", "mobileNumber", "currentStatus"];
  const missing  = required.filter((f) => !data[f]);
  if (missing.length) {
    return NextResponse.json({ error: `Missing fields: ${missing.join(", ")}` }, { status: 400, headers });
  }

  // Validate email format — prevents injection of multiple recipients
  if (!isValidEmail(String(data.email))) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400, headers });
  }

  // Sanitize fields used in email headers/subjects to prevent SMTP header injection
  data.fullName     = sanitizeHeader(String(data.fullName));
  data.email        = sanitizeHeader(String(data.email)).toLowerCase();
  data.mobileNumber = sanitizeHeader(String(data.mobileNumber));

  // Reject duplicate submissions — check email AND phone number permanently
  const [emailSnap, phoneSnap] = await Promise.all([
    adminDb.collection("applications").where("email", "==", data.email).limit(1).get(),
    adminDb.collection("applications").where("mobileNumber", "==", data.mobileNumber).limit(1).get(),
  ]);
  if (!emailSnap.empty || !phoneSnap.empty) {
    return NextResponse.json(
      {
        alreadyApplied: true,
        error:
          "You've already applied to DealSchool. Our team will reach out to you shortly. For any queries, contact support@dealschool.in",
      },
      { status: 409, headers }
    );
  }

  const docRef = adminDb.collection("applications").doc();

  const payload = {
    fullName:      String(data.fullName),
    mobileNumber:  String(data.mobileNumber),
    email:         String(data.email),
    linkedinUrl:   String(data.linkedinUrl   || ""),
    city:          String(data.city          || ""),
    currentStatus: String(data.currentStatus || ""),

    ...(data.currentStatus === "Student" && {
      collegeName:    data.collegeName,
      degree:         data.degree,
      graduationYear: data.graduationYear,
    }),
    ...(["Working Professional", "Recent Graduate (0–2 years of experience)"].includes(data.currentStatus) && {
      currentRole:                  data.currentRole,
      companyName:                  data.companyName,
      yearsOfExperience:            data.yearsOfExperience,
      degreeEducationalBackground:  data.degreeEducationalBackground,
      graduationYear:               data.graduationYear,
    }),
    ...(data.currentStatus === "Founder" && {
      startupName:             data.startupName,
      industrySector:          data.industrySector,
      startupLinkedinProfile:  data.startupLinkedinProfile,
    }),
    ...(data.currentStatus === "Freelancer" && {
      areaOfWork:                data.areaOfWork,
      yearsOfExperience:         data.yearsOfExperience,
      freelancerLinkedinProfile: data.freelancerLinkedinProfile,
    }),
    ...(data.currentStatus === "Other" && { otherStatusSpecify: data.otherStatusSpecify }),

    primaryReason:      String(data.primaryReason      || ""),
    primaryReasonOther: String(data.primaryReasonOther || ""),
    assessmentQ1:       String(data.assessmentQ1       || ""),
    assessmentQ2:       String(data.assessmentQ2       || ""),
    assessmentQ3:       String(data.assessmentQ3       || ""),
    resumeUrl:          String(data.resumeUrl || data.resumeLink || ""),
    discoverySource:    String(data.discoverySource    || ""),
    discoverySourceOther: String(data.discoverySourceOther || ""),

    status:    "pending",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await docRef.set(payload);
  logInfo("api/applications", "Application saved to Firestore", { applicationId: docRef.id, email: data.email, currentStatus: data.currentStatus });

  // ── Emails (non-fatal) ──────────────────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL || "support@dealschool.in";

  let affiliationLabel = "Affiliation Detail";
  let affiliationValue = "Core Curriculum";
  if (data.currentStatus === "Student") {
    affiliationLabel = "College / University";
    affiliationValue = String(data.collegeName || "Unspecified College");
  } else if (["Working Professional", "Recent Graduate (0–2 years of experience)"].includes(data.currentStatus)) {
    affiliationLabel = "Organization / Company";
    affiliationValue = String(data.companyName || "Unspecified Company");
  } else if (data.currentStatus === "Founder") {
    affiliationLabel = "Founded Venture";
    affiliationValue = String(data.startupName || "Unspecified Startup");
  }

  sendEmail({
    from:    CANDIDATE_SENDER,
    to:      String(data.email),
    subject: "Application Received",
    html:    renderAppReceivedCandidate({
      fullName:        String(data.fullName     || ""),
      currentStatus:   String(data.currentStatus || ""),
      affiliationLabel,
      affiliationValue,
      primaryReason:
        data.primaryReason === "Other"
          ? String(data.primaryReasonOther || "Other Purpose")
          : String(data.primaryReason || ""),
    }),
  }).catch((err) => logError("api/applications", `Candidate confirmation email failed applicantEmail=${data.email} applicationId=${docRef.id}`, err));

  sendEmail({
    from:    ADMIN_SENDER,
    to:      adminEmail,
    subject: `[Admissions] New Fellowship Application: ${String(data.fullName || "")}`,
    html:    renderAppReceivedAdmin({
      fullName:       String(data.fullName      || ""),
      email:          String(data.email         || ""),
      mobileNumber:   String(data.mobileNumber  || ""),
      city:           String(data.city          || ""),
      linkedinUrl:    String(data.linkedinUrl   || ""),
      currentStatus:  String(data.currentStatus || ""),
      collegeName:    data.collegeName,
      degree:         data.degree,
      graduationYear: data.graduationYear,
      currentRole:    data.currentRole,
      companyName:    data.companyName,
      yearsOfExperience:           data.yearsOfExperience,
      degreeEducationalBackground: data.degreeEducationalBackground,
      startupName:            data.startupName,
      industrySector:         data.industrySector,
      startupLinkedinProfile: data.startupLinkedinProfile,
      areaOfWork:                data.areaOfWork,
      freelancerLinkedinProfile: data.freelancerLinkedinProfile,
      otherStatusSpecify:    data.otherStatusSpecify,
      primaryReason:         String(data.primaryReason      || ""),
      primaryReasonOther:    data.primaryReasonOther,
      discoverySource:       String(data.discoverySource    || ""),
      discoverySourceOther:  data.discoverySourceOther,
      resumeUrl:      String(data.resumeLink || data.resumeUrl || ""),
      assessmentQ1:   String(data.assessmentQ1 || ""),
      assessmentQ2:   String(data.assessmentQ2 || ""),
      assessmentQ3:   String(data.assessmentQ3 || ""),
    }),
  }).catch((err) => logError("api/applications", `Admin notification email failed adminEmail=${adminEmail} applicationId=${docRef.id}`, err));

  logInfo("api/applications", "POST 201 completed", { applicationId: docRef.id });
  return NextResponse.json({ success: true, applicationId: docRef.id }, { status: 201, headers });
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
