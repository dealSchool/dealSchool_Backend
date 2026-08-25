import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { verifyAdmin } from "@/lib/verify-admin";
import { logInfo, logError } from "@/lib/logger";

export const runtime = "nodejs";

// One-off migration: older documents (created before the Cheerio email
// reminders existed) are missing the emailXxx tracking fields the reminder
// libs now read/write (see incomplete-applicant-reminders.ts,
// application-followup-reminder.ts, etc.). Without this field present, those
// libs' own no-repeat guards still work correctly (a missing field reads as
// "not yet sent"), but Firestore's own reminderStage/*Sent-style query
// conditions used by the older WhatsApp side would never have matched a doc
// that's missing its baseline fields entirely — this backfill makes that
// baseline explicit instead of relying on "missing == 0/false" behavior.
//
// Applicants who have already paid / fully converted are opted OUT (fields
// set to their "already sent" terminal state) rather than backfilled to
// "eligible" — the existing status-based query filters in each reminder lib
// already exclude paid applicants by construction, but this makes that
// explicit in the data itself as a second, independent safeguard, per direct
// request: never message someone who has already paid.
//
// Defaults to a dry run (no writes) — pass ?apply=true to actually commit.
// GET /admin/backfill-email-reminder-fields?apply=true

const PAID_STATUSES = new Set(["accepted", "declined", "cancelled"]);

function isConverted(data: FirebaseFirestore.DocumentData): boolean {
  return data.paymentStatus === "paid" || PAID_STATUSES.has(String(data.status));
}

interface CollectionSummary {
  collection: string;
  scanned: number;
  wouldUpdate: number;
  updated: number;
  optedOut: number;
}

async function commitInBatches(
  writes: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }>,
  apply: boolean
): Promise<number> {
  if (!apply || writes.length === 0) return writes.length;
  const BATCH_LIMIT = 450; // stay under Firestore's 500-write batch cap
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = adminDb.batch();
    for (const { ref, data } of writes.slice(i, i + BATCH_LIMIT)) {
      batch.set(ref, data, { merge: true });
    }
    await batch.commit();
  }
  return writes.length;
}

async function backfillStagedCollection(collectionName: string, apply: boolean): Promise<CollectionSummary> {
  const snap = await adminDb.collection(collectionName).get();
  const writes: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
  let scanned = 0;

  for (const doc of snap.docs) {
    scanned += 1;
    const data = doc.data();
    if (data.emailReminderStage !== undefined) continue; // already backfilled
    writes.push({ ref: doc.ref, data: { emailReminderStage: 0 } });
  }

  const updated = await commitInBatches(writes, apply);
  return { collection: collectionName, scanned, wouldUpdate: writes.length, updated: apply ? updated : 0, optedOut: 0 };
}

async function backfillApplications(apply: boolean): Promise<CollectionSummary> {
  const FIELDS = ["followupEmailSent", "auditFollowupEmailSent", "interviewReminderEmailSent", "paymentReminderEmailSent"] as const;
  const snap = await adminDb.collection("applications").get();
  const writes: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
  let scanned = 0;
  let optedOut = 0;

  for (const doc of snap.docs) {
    scanned += 1;
    const data = doc.data();
    const missing = FIELDS.filter((f) => data[f] === undefined);
    if (missing.length === 0) continue; // already backfilled

    const converted = isConverted(data);
    if (converted) optedOut += 1;
    const value = converted; // converted -> true (already handled/opt-out), else false (eligible baseline)
    const patch: Record<string, unknown> = {};
    for (const f of missing) patch[f] = value;
    writes.push({ ref: doc.ref, data: patch });
  }

  const updated = await commitInBatches(writes, apply);
  return { collection: "applications", scanned, wouldUpdate: writes.length, updated: apply ? updated : 0, optedOut };
}

export async function GET(request: NextRequest) {
  try {
    await verifyAdmin(request);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }

  const apply = request.nextUrl.searchParams.get("apply") === "true";

  try {
    const results = await Promise.all([
      backfillStagedCollection("applicationDrafts", apply),
      backfillStagedCollection("brochureRequests", apply),
      backfillApplications(apply),
    ]);

    logInfo("admin/backfill-email-reminder-fields", "Backfill run complete", { apply, results });
    return NextResponse.json({ apply, results });
  } catch (err) {
    logError("admin/backfill-email-reminder-fields", "Backfill run failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Backfill failed" }, { status: 500 });
  }
}
