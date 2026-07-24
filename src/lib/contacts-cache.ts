// Shared in-memory cache for GET /contacts first-page responses.
// Lives outside route.ts because Next.js route files may only export
// HTTP method handlers / route config, not arbitrary helpers.
export const LIST_CACHE_TTL_MS = 60 * 1000;
export const listCache = new Map<number, { body: unknown; expiresAt: number }>();

// Called after any out-of-band mutation (e.g. admin reply) so the dashboard
// doesn't show stale status for up to LIST_CACHE_TTL_MS.
export function invalidateContactsListCache() {
  listCache.clear();
}
