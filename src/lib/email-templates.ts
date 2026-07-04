// ─── Shared helpers ──────────────────────────────────────────────────────────
// All styles are inlined — Gmail and Outlook strip <style> blocks and @import.
// Brand: #082C6C navy, #D4A62A gold, #FAFAF8 cream, #111111 near-black, Plus Jakarta Sans / Playfair Display

const FONT = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
const SERIF = "'Playfair Display',Georgia,'Times New Roman',serif";

function base(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
</head>
<body style="margin:0;padding:0;background:#ECEAE3;font-family:${FONT};-webkit-font-smoothing:antialiased;">
  <!-- outer spacer -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ECEAE3;padding:32px 16px;">
    <tr><td align="center">
      <!-- card -->
      <table width="620" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 32px rgba(8,44,108,.13);">

        <!-- ── HEADER ── -->
        <tr>
          <td style="background:#082C6C;padding:32px 40px 0;">
            <p style="margin:0;font-family:${FONT};font-size:22px;font-weight:700;letter-spacing:2.5px;color:#ffffff;text-transform:uppercase;line-height:1;">
              Deal<span style="color:#D4A62A;">School</span>
            </p>
            <p style="margin:6px 0 28px;font-family:${FONT};font-size:10px;font-weight:500;color:rgba(255,255,255,0.45);letter-spacing:3.5px;text-transform:uppercase;">
              Venture Fellowship
            </p>
          </td>
        </tr>
        <!-- gold accent bar -->
        <tr>
          <td style="height:3px;background:linear-gradient(90deg,#B8891A,#D4A62A 40%,#F0C040 70%,#D4A62A);font-size:0;line-height:0;">&nbsp;</td>
        </tr>

        <!-- ── BODY ── -->
        <tr>
          <td style="padding:36px 40px;background:#ffffff;font-family:${FONT};font-size:15px;line-height:1.75;color:#111111;">
            ${content}
          </td>
        </tr>

        <!-- ── FOOTER ── -->
        <tr>
          <td style="background:#082C6C;padding:24px 40px;text-align:center;">
            <p style="margin:0 0 5px;font-family:${FONT};font-size:13px;font-weight:700;color:#D4A62A;letter-spacing:2.5px;text-transform:uppercase;">DealSchool</p>
            <p style="margin:0;font-family:${FONT};font-size:11px;color:rgba(255,255,255,0.45);letter-spacing:1px;">Empowering India's Deal Ecosystem</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Inline-styled helpers ──────────────────────────────────────────────────

function greeting(name: string): string {
  return `<p style="margin:0 0 20px;font-family:${SERIF};font-size:20px;font-weight:600;color:#082C6C;">Hi ${esc(name)},</p>`;
}

function sectionTitle(label: string): string {
  return `<p style="margin:28px 0 10px;font-family:${FONT};font-size:10px;font-weight:700;color:#D4A62A;text-transform:uppercase;letter-spacing:2.5px;padding-bottom:8px;border-bottom:1px solid #EDE9DE;">${label}</p>`;
}

function field(label: string, value: string | undefined | null): string {
  if (!value) return "";
  return `<div style="padding:9px 0 9px 14px;border-left:2px solid #EDE9DE;margin-bottom:6px;">
    <div style="font-family:${FONT};font-size:10px;font-weight:600;color:#5F6368;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:3px;">${label}</div>
    <div style="font-family:${FONT};font-size:14px;font-weight:500;color:#111111;">${esc(value)}</div>
  </div>`;
}

function fieldLink(label: string, value: string | undefined | null): string {
  if (!value) return "";
  return `<div style="padding:9px 0 9px 14px;border-left:2px solid #EDE9DE;margin-bottom:6px;">
    <div style="font-family:${FONT};font-size:10px;font-weight:600;color:#5F6368;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:3px;">${label}</div>
    <div style="font-family:${FONT};font-size:14px;font-weight:500;"><a href="${esc(value)}" style="color:#0D3B8E;text-decoration:none;">${esc(value)}</a></div>
  </div>`;
}

function badge(text: string): string {
  return `<span style="display:inline-block;background:rgba(212,166,42,0.13);color:#8A6510;font-family:${FONT};font-size:12px;font-weight:600;padding:3px 12px;border-radius:20px;letter-spacing:0.5px;">${esc(text)}</span>`;
}

function infoBanner(html: string): string {
  return `<div style="background:#FAFAF8;border-radius:8px;padding:16px 20px;margin:20px 0;border-left:3px solid #D4A62A;font-family:${FONT};font-size:14px;color:#374151;line-height:1.6;">${html}</div>`;
}

function answerBox(text: string): string {
  return `<div style="background:#FAFAF8;border-radius:8px;padding:16px 20px;font-family:${FONT};font-size:14px;line-height:1.65;color:#374151;border:1px solid #EDE9DE;margin:6px 0 18px;white-space:pre-wrap;word-break:break-word;">${esc(text)}</div>`;
}

function qLabel(text: string): string {
  return `<p style="margin:16px 0 4px;font-family:${FONT};font-size:12px;font-weight:700;color:#082C6C;letter-spacing:0.5px;text-transform:uppercase;">${text}</p>`;
}

function divider(): string {
  return `<hr style="border:none;border-top:1px solid #EDEAE2;margin:24px 0;" />`;
}

function btn(href: string, label: string): string {
  return `<a href="${esc(href)}" style="display:inline-block;margin:10px 0 20px;padding:13px 32px;background:#082C6C;color:#ffffff;border-radius:6px;font-family:${FONT};font-size:14px;font-weight:600;text-decoration:none;letter-spacing:0.5px;">${label}</a>`;
}

function p(html: string, style = ""): string {
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;color:#111111;line-height:1.75;${style}">${html}</p>`;
}

function twoCol(left: string, right: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="50%" style="vertical-align:top;padding-right:6px;">${left}</td>
    <td width="50%" style="vertical-align:top;padding-left:6px;">${right}</td>
  </tr></table>`;
}

function signature(name: string): string {
  return `<p style="margin:24px 0 0;font-family:${FONT};font-size:15px;color:#111111;line-height:1.75;">Warm regards,<br /><strong>${name}</strong></p>`;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Application received — candidate ────────────────────────────────────────

export interface AppReceivedCandidateProps {
  fullName: string;
  currentStatus: string;
  affiliationLabel: string;
  affiliationValue: string;
  primaryReason: string;
}

export function renderAppReceivedCandidate(pr: AppReceivedCandidateProps): string {
  return base(`
${greeting(pr.fullName)}
${p("Thank you for applying to the <strong style=\"color:#082C6C;\">DealSchool Venture Fellowship</strong>. We're excited to review your application — our admissions committee will be in touch soon.")}
${infoBanner("&#10003;&nbsp;&nbsp;Your application has been successfully received and is currently pending review by our admissions committee.")}
${sectionTitle("Application Summary")}
<div style="padding:9px 0 9px 14px;border-left:2px solid #EDE9DE;margin-bottom:6px;">
  <div style="font-family:${FONT};font-size:10px;font-weight:600;color:#5F6368;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:3px;">Status</div>
  <div>${badge(pr.currentStatus)}</div>
</div>
${field(pr.affiliationLabel, pr.affiliationValue)}
${field("Primary Goal", pr.primaryReason)}
${divider()}
<div style="background:#FAFAF8;border-radius:8px;padding:20px 24px;margin:20px 0;">
  <p style="margin:0 0 8px;font-family:${FONT};font-size:14px;font-weight:700;color:#082C6C;">What happens next?</p>
  <p style="margin:0 0 8px;font-family:${FONT};font-size:14px;color:#374151;">Our admissions team will review your application and reach out within <strong>3–5 business days</strong>. Watch this inbox for updates on your application status.</p>
  <p style="margin:0;font-family:${FONT};font-size:14px;color:#374151;">In the meantime, feel free to reach us at <a href="mailto:support@dealschool.in" style="color:#0D3B8E;">support@dealschool.in</a> if you have any questions.</p>
</div>
${signature("DealSchool Admissions Team")}`);
}

// ─── Application received — admin ────────────────────────────────────────────

export interface AppReceivedAdminProps {
  fullName: string;
  email: string;
  mobileNumber: string;
  city?: string;
  linkedinUrl?: string;
  currentStatus: string;
  collegeName?: string;
  degree?: string;
  graduationYear?: string | number;
  currentRole?: string;
  companyName?: string;
  yearsOfExperience?: string | number;
  degreeEducationalBackground?: string;
  startupName?: string;
  industrySector?: string;
  startupLinkedinProfile?: string;
  areaOfWork?: string;
  freelancerLinkedinProfile?: string;
  otherStatusSpecify?: string;
  primaryReason: string;
  primaryReasonOther?: string;
  discoverySource: string;
  discoverySourceOther?: string;
  resumeUrl?: string;
  assessmentQ1?: string;
  assessmentQ2?: string;
  assessmentQ3?: string;
}

export function renderAppReceivedAdmin(pr: AppReceivedAdminProps): string {
  const reason = pr.primaryReason === "Other" ? String(pr.primaryReasonOther || "Other") : pr.primaryReason;
  const discovery = pr.discoverySource === "Other" ? String(pr.discoverySourceOther || "Other") : pr.discoverySource;
  const hasEducation = pr.collegeName || pr.degree || pr.graduationYear || pr.degreeEducationalBackground;
  const hasStartup = pr.startupName || pr.industrySector || pr.startupLinkedinProfile;
  const hasFreelancer = pr.areaOfWork || pr.freelancerLinkedinProfile;
  const hasAssessment = pr.assessmentQ1 || pr.assessmentQ2 || pr.assessmentQ3;

  const statusBadgeField = `<div style="padding:9px 0 9px 14px;border-left:2px solid #EDE9DE;margin-bottom:6px;">
    <div style="font-family:${FONT};font-size:10px;font-weight:600;color:#5F6368;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:3px;">Current Status</div>
    <div>${badge(pr.currentStatus)}</div>
  </div>`;

  return base(`
<p style="margin:0 0 4px;font-family:${FONT};font-size:11px;color:#5F6368;text-transform:uppercase;letter-spacing:1.5px;">New Submission</p>
<p style="margin:0 0 20px;font-family:${SERIF};font-size:20px;font-weight:600;color:#082C6C;">Fellowship Application Received</p>

${sectionTitle("Applicant Information")}
${twoCol(field("Full Name", pr.fullName), field("Email Address", pr.email))}
${twoCol(field("Phone Number", pr.mobileNumber), field("City", pr.city))}
${fieldLink("LinkedIn Profile", pr.linkedinUrl)}

${sectionTitle("Professional Profile")}
${twoCol(statusBadgeField, field("Current Role", pr.currentRole))}
${twoCol(field("Company / Organisation", pr.companyName), pr.yearsOfExperience ? field("Years of Experience", String(pr.yearsOfExperience)) : "")}
${pr.otherStatusSpecify ? field("Other Status", pr.otherStatusSpecify) : ""}

${hasEducation ? `${sectionTitle("Education")}
${twoCol(field("College / University", pr.collegeName), field("Degree", pr.degree))}
${twoCol(pr.graduationYear ? field("Graduation Year", String(pr.graduationYear)) : "", field("Educational Background", pr.degreeEducationalBackground))}` : ""}

${hasStartup ? `${sectionTitle("Startup Details")}
${twoCol(field("Startup Name", pr.startupName), field("Industry Sector", pr.industrySector))}
${fieldLink("Startup LinkedIn", pr.startupLinkedinProfile)}` : ""}

${hasFreelancer ? `${sectionTitle("Freelancer Details")}
${twoCol(field("Area of Work", pr.areaOfWork), fieldLink("Freelancer LinkedIn", pr.freelancerLinkedinProfile))}` : ""}

${sectionTitle("Application Details")}
${twoCol(field("Primary Reason", reason), field("Discovery Source", discovery))}
${fieldLink("Resume / Portfolio", pr.resumeUrl)}

${hasAssessment ? `${sectionTitle("Assessment Responses")}
${pr.assessmentQ1 ? `${qLabel("Question 1")}${answerBox(pr.assessmentQ1)}` : ""}
${pr.assessmentQ2 ? `${qLabel("Question 2")}${answerBox(pr.assessmentQ2)}` : ""}
${pr.assessmentQ3 ? `${qLabel("Question 3")}${answerBox(pr.assessmentQ3)}` : ""}` : ""}`);
}

// ─── Status change emails ─────────────────────────────────────────────────────

export function renderAppUnderReview(pr: { fullName: string }): string {
  return base(`
${greeting(pr.fullName)}
${p("Your DealSchool Venture Fellowship application is now <strong style=\"color:#082C6C;\">under review</strong> by our admissions committee.")}
${infoBanner("Our team is carefully evaluating your profile and responses. We'll be in touch within <strong>3–5 business days</strong> with the next steps.")}
${p("Thank you for your patience. We appreciate your interest in joining the DealSchool Fellowship.")}
${signature("DealSchool Admissions Team")}`);
}

export function renderInterviewInvited(pr: { fullName: string }): string {
  return base(`
${greeting(pr.fullName)}
${p("Congratulations! After reviewing your application, we are pleased to invite you to <strong style=\"color:#082C6C;\">interview for the DealSchool Venture Fellowship</strong>.")}
${infoBanner("Our admissions team will reach out to you shortly with interview scheduling details. Please keep this inbox and your phone accessible.")}
${p("This is an exciting step — we look forward to learning more about you and your goals.")}
${signature("DealSchool Admissions Team")}`);
}

export function renderAppDeclined(pr: { fullName: string }): string {
  return base(`
${greeting(pr.fullName)}
${p("Thank you for your interest in the DealSchool Venture Fellowship and for the time you invested in your application.")}
${p("After careful deliberation, we regret to inform you that we are unable to move forward with your application for this cohort. This decision reflects the highly competitive nature of our programme — not a measure of your potential or merit.")}
${infoBanner("We receive a large number of applications for a limited number of seats, and many strong candidates are not selected in any given cohort.")}
${p("We encourage you to apply again for our next cohort. In the meantime, follow us on LinkedIn for updates, resources, and fellowship announcements.")}
${signature("DealSchool Admissions Team")}`);
}

// ─── Payment link ─────────────────────────────────────────────────────────────

export function renderPaymentLinkEmail(pr: {
  fullName: string;
  linkUrl: string;
  feeDisplay: string;
}): string {
  return base(`
${greeting(pr.fullName)}
${p("Congratulations — you've been <strong style=\"color:#082C6C;\">accepted to the DealSchool Venture Fellowship!</strong> We're thrilled to have you join this cohort.")}
${infoBanner(`To confirm and secure your seat, please complete the fellowship fee payment of <strong>${esc(pr.feeDisplay)}</strong> using the secure link below.`)}
${sectionTitle("Payment Details")}
${field("Fellowship Fee", pr.feeDisplay)}
${field("Link Validity", "30 minutes from time of issue")}
<p style="margin:20px 0 8px;">${btn(pr.linkUrl, "Complete Payment &rarr;")}</p>
<p style="margin:0;font-family:${FONT};font-size:13px;color:#5F6368;">If this link has expired, please contact us at <a href="mailto:support@dealschool.in" style="color:#0D3B8E;">support@dealschool.in</a> and we'll issue a fresh one promptly.</p>
${signature("DealSchool Team")}`);
}

// ─── Payment receipt ──────────────────────────────────────────────────────────

export function renderPaymentReceiptEmail(pr: {
  applicantName: string;
  feeDisplay: string;
  rzpPaymentId: string;
}): string {
  return base(`
${greeting(pr.applicantName)}
${p("Your payment has been <strong style=\"color:#082C6C;\">confirmed</strong>. Welcome to the DealSchool Venture Fellowship — we're delighted to have you on board!")}
${sectionTitle("Payment Confirmation")}
${field("Amount Paid", pr.feeDisplay)}
${field("Transaction ID", pr.rzpPaymentId)}
${infoBanner("Our team will be in touch very soon with onboarding details, your cohort schedule, and everything you need to get started.")}
<p style="margin:24px 0 0;font-family:${FONT};font-size:15px;color:#111111;">We're excited for what's ahead,<br /><strong>DealSchool Team</strong></p>`);
}

// ─── Payment receipt — admin notification ────────────────────────────────────

export function renderPaymentReceiptAdminEmail(pr: {
  applicantName: string;
  applicantEmail: string;
  feeDisplay: string;
  rzpPaymentId: string;
  applicationId: string;
}): string {
  return base(`
<p style="margin:0 0 4px;font-family:${FONT};font-size:13px;color:#5F6368;">Payment Confirmed</p>
<p style="margin:0 0 24px;font-family:${SERIF};font-size:20px;font-weight:600;color:#082C6C;">Fellowship Fee Received</p>
${sectionTitle("Payment Details")}
${field("Applicant Name", pr.applicantName)}
${field("Email Address", pr.applicantEmail)}
${field("Amount Paid", pr.feeDisplay)}
${field("Razorpay Payment ID", pr.rzpPaymentId)}
${field("Application ID", pr.applicationId)}`);
}

// ─── Cancellation / refund emails ─────────────────────────────────────────────

export function renderCancellationNoRefundEmail(pr: { fullName: string; feeDisplay: string }): string {
  return base(`
${greeting(pr.fullName)}
${p("We've processed your request to cancel your seat in the <strong style=\"color:#082C6C;\">DealSchool Venture Fellowship</strong>.")}
${infoBanner(`Per our cancellation policy, requests made on or after the programme start date are not eligible for a refund, so your fee of <strong>${esc(pr.feeDisplay)}</strong> is non-refundable in this case.`)}
${p("If you believe this is a mistake, please reach out to us at <a href=\"mailto:support@dealschool.in\" style=\"color:#0D3B8E;\">support@dealschool.in</a>.")}
${signature("DealSchool Team")}`);
}

export function renderRefundInitiatedEmail(pr: {
  fullName: string;
  feeDisplay: string;
  refundDisplay: string;
  refundPercent: number;
}): string {
  return base(`
${greeting(pr.fullName)}
${p("We've processed your cancellation request for the <strong style=\"color:#082C6C;\">DealSchool Venture Fellowship</strong>.")}
${infoBanner(`Per our cancellation policy, you're eligible for a <strong>${pr.refundPercent}% refund</strong>. A refund of <strong>${esc(pr.refundDisplay)}</strong> (of your ${esc(pr.feeDisplay)} fee) has been initiated to your original payment method.`)}
${sectionTitle("Refund Details")}
${field("Fee Paid", pr.feeDisplay)}
${field("Refund Amount", pr.refundDisplay)}
${field("Refund %", `${pr.refundPercent}%`)}
<p style="margin:0;font-family:${FONT};font-size:13px;color:#5F6368;">Refunds typically take <strong>5–7 business days</strong> to reflect in your account, depending on your bank. We'll email you again once it's completed.</p>
${signature("DealSchool Team")}`);
}

export function renderRefundCompletedEmail(pr: {
  applicantName: string;
  refundDisplay: string;
  rzpRefundId: string;
}): string {
  return base(`
${greeting(pr.applicantName)}
${p("Your refund for the <strong style=\"color:#082C6C;\">DealSchool Venture Fellowship</strong> has been <strong>completed</strong>.")}
${sectionTitle("Refund Confirmation")}
${field("Amount Refunded", pr.refundDisplay)}
${field("Refund ID", pr.rzpRefundId)}
${p("It may take a few additional days for your bank to reflect this in your statement.")}
${signature("DealSchool Team")}`);
}

export interface RefundAdminNotificationProps {
  applicantName: string;
  applicantEmail: string;
  applicationId: string;
  status: "initiated" | "completed" | "failed";
  refundDisplay: string;
  refundPercent: number;
  rzpRefundId: string;
}

export function renderRefundAdminNotification(pr: RefundAdminNotificationProps): string {
  const statusLabel =
    pr.status === "initiated" ? "Refund Initiated" :
    pr.status === "completed" ? "Refund Completed" : "Refund FAILED";

  return base(`
<p style="margin:0 0 4px;font-family:${FONT};font-size:13px;color:#5F6368;">${statusLabel}</p>
<p style="margin:0 0 24px;font-family:${SERIF};font-size:20px;font-weight:600;color:#082C6C;">Fellowship Fee Refund ${badge(pr.status.toUpperCase())}</p>
${sectionTitle("Refund Details")}
${field("Applicant Name", pr.applicantName)}
${field("Email Address", pr.applicantEmail)}
${field("Refund Amount", pr.refundDisplay)}
${field("Refund %", `${pr.refundPercent}%`)}
${field("Razorpay Refund ID", pr.rzpRefundId)}
${field("Application ID", pr.applicationId)}
${pr.status === "failed" ? infoBanner("This refund FAILED at Razorpay. Please investigate and process it manually via the Razorpay dashboard if needed.") : ""}`);
}

// ─── Admin password reset ─────────────────────────────────────────────────────

export function renderAdminPasswordReset(pr: { resetLink: string }): string {
  return base(`
<p style="margin:0 0 20px;font-family:${SERIF};font-size:20px;font-weight:600;color:#082C6C;">Password Reset Request</p>
${p("A password reset was requested for the DealSchool Admin Portal. Click the button below to set a new password.")}
${infoBanner("This reset link is valid for <strong>30 minutes</strong> from the time it was issued.")}
<p style="margin:20px 0 8px;">${btn(pr.resetLink, "Reset Password &rarr;")}</p>
${divider()}
<p style="margin:0;font-family:${FONT};font-size:13px;color:#5F6368;">If you did not request a password reset, you can safely ignore this email — your password will remain unchanged.</p>`);
}

// ─── Admin OTP — change password ──────────────────────────────────────────────

export function renderAdminOTP(pr: { otpCode: string }): string {
  return base(`
<p style="margin:0 0 20px;font-family:${SERIF};font-size:20px;font-weight:600;color:#082C6C;">Your One-Time Password</p>
${p("Use the code below to confirm your Admin Portal password change. Do not share this with anyone.")}
<p style="font-size:40px;font-family:'Courier New',Courier,monospace;letter-spacing:14px;text-align:center;font-weight:700;color:#082C6C;margin:28px 0;background:#FAFAF8;border-radius:8px;padding:24px 0;">${esc(pr.otpCode)}</p>
<p style="text-align:center;font-family:${FONT};color:#5F6368;font-size:13px;margin:0 0 16px;">Valid for <strong>10 minutes</strong> only. Do not share this with anyone.</p>
${divider()}
<p style="margin:0;font-family:${FONT};font-size:12px;color:#9ca3af;">If you did not initiate this request, please review your account security immediately or contact us at <a href="mailto:support@dealschool.in" style="color:#0D3B8E;">support@dealschool.in</a>.</p>`);
}

// ─── Contact inquiry ──────────────────────────────────────────────────────────

export interface ContactInquiryAdminProps {
  name: string;
  email: string;
  subject: string;
  message: string;
}

export function renderContactInquiryAdmin(pr: ContactInquiryAdminProps): string {
  return base(`
<p style="margin:0 0 4px;font-family:${FONT};font-size:13px;color:#5F6368;">New Inquiry</p>
<p style="margin:0 0 24px;font-family:${SERIF};font-size:20px;font-weight:600;color:#082C6C;">Contact Form Submission</p>
${sectionTitle("Sender Details")}
${field("Name", pr.name)}
${field("Email Address", pr.email)}
${field("Subject", pr.subject)}
${sectionTitle("Message")}
${answerBox(pr.message)}`);
}

export interface ContactInquiryCandidateProps {
  name: string;
  subject: string;
  message: string;
}

export function renderContactInquiryCandidate(pr: ContactInquiryCandidateProps): string {
  return base(`
${greeting(pr.name)}
${p("Thank you for reaching out to DealSchool. We've received your message and will get back to you within <strong>1–2 business days</strong>.")}
${sectionTitle("Your Message")}
${field("Subject", pr.subject)}
${answerBox(pr.message)}
${signature("DealSchool Team")}`);
}
