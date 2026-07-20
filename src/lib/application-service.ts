import { FieldValue, Filter } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { sendEmail } from "@/lib/mailer";
import { logInfo, logError } from "@/lib/logger";
import { isValidEmail, sanitizeHeader } from "@/lib/validate";
import {
  renderAppReceivedCandidate,
  renderAppReceivedAdmin,
} from "@/lib/email-templates";

const CANDIDATE_SENDER = "DealSchool <support@dealschool.in>";
const ADMIN_SENDER     = "DealSchool <support@dealschool.in>";

export type SubmitApplicationResult =
  | { ok: true; applicationId: string }
  | { ok: false; status: number; body: Record<string, unknown> };

// Shared by POST /applications (direct submit) and POST /applications/draft/[draftId]/submit
// (draft finalize) — validation, duplicate check, Firestore write, and notification emails
// must stay identical between both entry points.
export async function submitApplication(data: any): Promise<SubmitApplicationResult> {
  const required = ["fullName", "email", "mobileNumber", "currentStatus"];
  const missing  = required.filter((f) => !data[f]);
  if (missing.length) {
    return { ok: false, status: 400, body: { error: `Missing fields: ${missing.join(", ")}` } };
  }

  if (!isValidEmail(String(data.email))) {
    return { ok: false, status: 400, body: { error: "Invalid email address" } };
  }

  data.fullName     = sanitizeHeader(String(data.fullName));
  data.email        = sanitizeHeader(String(data.email)).toLowerCase();
  data.mobileNumber = sanitizeHeader(String(data.mobileNumber));

  const dupSnap = await adminDb
    .collection("applications")
    .where(Filter.or(
      Filter.where("email", "==", data.email),
      Filter.where("mobileNumber", "==", data.mobileNumber),
    ))
    .limit(1)
    .get();
  if (!dupSnap.empty) {
    return {
      ok: false,
      status: 409,
      body: {
        alreadyApplied: true,
        error:
          "You've already applied to DealSchool. Our team will reach out to you shortly. For any queries, contact support@dealschool.in",
      },
    };
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
  logInfo("application-service", "Application saved to Firestore", { applicationId: docRef.id, email: data.email, currentStatus: data.currentStatus });

  const adminEmail = process.env.NOTIFICATION_EMAIL || "support@dealschool.in";

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
  }).catch((err) => logError("application-service", `Candidate confirmation email failed applicantEmail=${data.email} applicationId=${docRef.id}`, err));

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
  }).catch((err) => logError("application-service", `Admin notification email failed adminEmail=${adminEmail} applicationId=${docRef.id}`, err));

  return { ok: true, applicationId: docRef.id };
}
