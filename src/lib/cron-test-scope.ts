import type { CollectionReference, DocumentData, QueryDocumentSnapshot, Query } from "firebase-admin/firestore";

// Every reminder lib uses `opts.force ? FORCE_BYPASS_THRESHOLD : new Date(Date.now() - N*3600000)`
// as the "<=" comparison value for its age-threshold filter. The threshold
// must be pushed into the future (not the epoch) to actually bypass a
// "<=" filter — a doc's real timestamp is virtually always AFTER 1970, so
// comparing "<= epoch" makes a match less likely, not more, which is the
// opposite of what force=true is documented to do ("bypasses the age
// threshold for testing"). Pair force=true with testId in real usage anyway
// (see resolveCronDocs below) so this only ever affects one document.
export const FORCE_BYPASS_THRESHOLD = new Date(8640000000000000); // max valid JS Date

// When opts.testId is set (local/manual testing only), scope a cron run to
// exactly that one document instead of running the real query — otherwise a
// force=true test run against a live database sweeps in every real record
// that already happens to match the filters (e.g. every in-progress draft),
// not just the one you meant to test.
export async function resolveCronDocs(
  collection: CollectionReference<DocumentData>,
  query: Query<DocumentData>,
  testId: string | undefined
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
  if (testId) {
    const doc = await collection.doc(testId).get();
    // Cast is safe: we've just confirmed .exists, so .data() is guaranteed defined,
    // same guarantee QueryDocumentSnapshot carries from a real query's results.
    return doc.exists ? [doc as QueryDocumentSnapshot<DocumentData>] : [];
  }
  const snapshot = await query.get();
  return snapshot.docs;
}
