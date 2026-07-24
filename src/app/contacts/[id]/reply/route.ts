import { NextRequest, NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { verifyAdmin } from "@/lib/verify-admin";
import { serializeDoc } from "@/lib/serialize";
import { sendEmail } from "@/lib/mailer";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { renderContactReply } from "@/lib/email-templates";
import { invalidateContactsListCache } from "@/lib/contacts-cache";

export const runtime = "nodejs";

const CONTACT_SENDER = "DealSchool Support <support@dealschool.in>";

function buildReplySubject(originalSubject: string): string {
  const trimmed = originalSubject.trim();
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

// ─── POST /contacts/[id]/reply — admin: reply to a contact inquiry by email ───
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const origin  = request.headers.get("origin");
  const headers = corsHeaders(origin);
  logInfo("api/contacts/[id]/reply", "POST received", { id });

  let admin: { uid: string; email: string };
  try { admin = await verifyAdmin(request); }
  catch {
    logWarn("api/contacts/[id]/reply", "Unauthorized reply attempt", { id });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  let body: any;
  try { body = await request.json(); }
  catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400, headers });
  }
  const safeReplyMessage = message.slice(0, 5000);

  const docRef = adminDb.collection("contacts").doc(id);
  const snap   = await docRef.get();
  if (!snap.exists) {
    logWarn("api/contacts/[id]/reply", "Contact not found", { id });
    return NextResponse.json({ error: "Contact not found" }, { status: 404, headers });
  }

  const contact = snap.data()!;
  const replySubject = buildReplySubject(String(contact.subject || ""));

  try {
    await sendEmail({
      from:    CONTACT_SENDER,
      to:      contact.email,
      subject: replySubject,
      html:    renderContactReply({
        name:            contact.name,
        subject:         contact.subject,
        originalMessage: contact.message,
        replyMessage:    safeReplyMessage,
      }),
    });
  } catch (err) {
    logError("api/contacts/[id]/reply", `Reply email FAILED contactId=${id} to=${contact.email}`, err);
    return NextResponse.json({ error: "Failed to send reply email. Please try again." }, { status: 502, headers });
  }

  const replyEntry = {
    message:   safeReplyMessage,
    sentAt:    Timestamp.now(),
    repliedBy: admin.email,
  };

  // The email has already been sent at this point — if this write fails, we must
  // NOT surface a generic error, or the admin will retry and send a duplicate email.
  try {
    await docRef.update({
      status:    "replied",
      replies:   FieldValue.arrayUnion(replyEntry),
      updatedAt: FieldValue.serverTimestamp(),
    });
    invalidateContactsListCache();
  } catch (err) {
    logError("api/contacts/[id]/reply", `Reply email sent but Firestore update FAILED contactId=${id}`, err);
    return NextResponse.json(
      {
        success: true,
        warning: "Reply email was sent, but we couldn't save it to this message's history. Refresh before replying again.",
        contact: { id, ...serializeDoc(contact) },
      },
      { headers }
    );
  }

  logInfo("api/contacts/[id]/reply", "Reply sent and recorded", { id, repliedBy: admin.email });

  const serializedReplies = [...(contact.replies || []), replyEntry].map((r) => ({
    ...r,
    sentAt: r.sentAt instanceof Timestamp ? r.sentAt.toDate().toISOString() : r.sentAt,
  }));
  const merged = serializeDoc({
    ...contact,
    status:    "replied",
    updatedAt: new Date().toISOString(),
  });
  return NextResponse.json(
    { success: true, contact: { id, ...merged, replies: serializedReplies } },
    { headers }
  );
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
