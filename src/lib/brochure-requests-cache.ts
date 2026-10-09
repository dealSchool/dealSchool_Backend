// Shared in-memory cache for GET /brochure-requests first-page responses.
// Lives outside route.ts because Next.js route files may only export
// HTTP method handlers / route config, not arbitrary helpers.
export const LIST_CACHE_TTL_MS = 60 * 1000;
export const listCache = new Map<string, { body: unknown; expiresAt: number }>();

// Called after any out-of-band mutation (new request, delete) so the
// dashboard doesn't show a stale total for up to LIST_CACHE_TTL_MS.
export function invalidateBrochureRequestsListCache() {
  listCache.clear();
}
