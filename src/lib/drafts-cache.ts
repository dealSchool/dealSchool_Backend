// Shared in-memory cache for GET /applications/draft first-page responses.
// Lives outside route.ts because Next.js route files may only export
// HTTP method handlers / route config, not arbitrary helpers.
export const LIST_CACHE_TTL_MS = 60 * 1000;
export const listCache = new Map<string, { body: unknown; expiresAt: number }>();

// Called after any out-of-band mutation (step update, submit, delete) so the
// dashboard doesn't show stale drafts/counts for up to LIST_CACHE_TTL_MS.
export function invalidateDraftsListCache() {
  listCache.clear();
}
