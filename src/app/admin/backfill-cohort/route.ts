import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { verifyAdmin } from "@/lib/verify-admin";
import { logInfo, logError } from "@/lib/logger";
import { LEGACY_COHORT } from "@/lib/cohort-settings";
import { invalidateApplicationsListCache } from "@/lib/applications-cache";
import { invalidateDraftsListCache } from "@/lib/drafts-cache";
import { invalidateContactsListCache } from "@/lib/contacts-cache";
import { invalidateBrochureRequestsListCache } from "@/lib/brochure-requests-cache";

export const runtime = "nodejs";

// One-off migration: every record created before cohorts existed has no
// `cohort` field. The cohort filters (?cohort=N on the list endpoints) use a
// Firestore equality query, which silently skips documents missing the field —
// so every existing record is stamped as Cohort 1 here. Run this ONCE after
// deploying the cohort code and BEFORE activating Cohort 2.
//
// Only sets `cohort` on documents that don't already have it (never overwrites),
// and doesn't touch updatedAt so list ordering is unchanged. Safe to re-run.
//
// Defaults to a dry run (no writes) — pass ?apply=true to actually commit.
// GET /admin/backfill-cohort?apply=true

const COLLECTIONS = ["applications", "applicationDrafts", "contacts", "brochureRequests", "payments"] as const;

interface CollectionSummary {
  collection: string;
  scanned: number;
  missingCohort: number;
  updated: number;
}

async function backfillCollection(name: string, apply: boolean): Promise<CollectionSummary> {
  const snap = await adminDb.collection(name).get();
  const missing = snap.docs.filter((d) => d.data().cohort === undefined);

  let updated = 0;
  if (apply) {
    const BATCH_LIMIT = 450; // stay under Firestore's 500-write batch cap
    for (let i = 0; i < missing.length; i += BATCH_LIMIT) {
      const batch = adminDb.batch();
      for (const doc of missing.slice(i, i + BATCH_LIMIT)) {
        batch.update(doc.ref, { cohort: LEGACY_COHORT });
      }
      await batch.commit();
      updated += Math.min(BATCH_LIMIT, missing.length - i);
    }
  }
  return { collection: name, scanned: snap.size, missingCohort: missing.length, updated };
}

export async function GET(request: NextRequest) {
  try {
    await verifyAdmin(request);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }

  const apply = request.nextUrl.searchParams.get("apply") === "true";

  try {
    // Sequential, not Promise.all — each pass reads a whole collection, and
    // this is a one-off job so there's no reason to spike Firestore reads.
    const results: CollectionSummary[] = [];
    for (const name of COLLECTIONS) results.push(await backfillCollection(name, apply));

    if (apply) {
      invalidateApplicationsListCache();
      invalidateDraftsListCache();
      invalidateContactsListCache();
      invalidateBrochureRequestsListCache();
    }

    logInfo("admin/backfill-cohort", "Backfill run complete", { apply, results });
    return NextResponse.json({ apply, assignedCohort: LEGACY_COHORT, results });
  } catch (err) {
    logError("admin/backfill-cohort", "Backfill run failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Backfill failed" }, { status: 500 });
  }
}
