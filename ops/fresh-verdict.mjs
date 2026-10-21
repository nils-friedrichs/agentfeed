// ops/fresh-verdict.mjs: what "fresh" means for /robots.txt in ops/discovery-check.mjs (R19).
//
// The origin sends `Cache-Control: no-cache` + an ETag on /robots.txt, and ops/discovery-check.mjs used to assert that header. Behind Cloudflare
// the client sees `max-age=14400` on that one path instead (the zone's Browser Cache TTL overrides the origin; measured 21 Oct 2026), so the header
// can never pass there. What the check is for is a body that cannot be hours old: the edge must ask our origin on every request
// (cf-cache-status REVALIDATED, or DYNAMIC / BYPASS when the path is not cached at all), and the body must carry an ETag that a conditional GET
// turns into a 304. HIT, MISS, STALE and UPDATING all mean the edge answered, or will answer the next request, from its own copy.
//
// Straight to the origin (a local stage, no Cloudflare in front) there is no cf-cache-status; there our own `no-cache` is the statement.
const EDGE_ASKED_ORIGIN = new Set(['REVALIDATED', 'DYNAMIC', 'BYPASS']);

/** @param {{status:number, cacheControl:?string, etag:?string, cfCacheStatus:?string, conditionalStatus:?number}} r */
export function robotsVerdict(r) {
  const why = [];
  if (r.status !== 200) why.push(`status ${r.status}`);
  if (!r.etag) why.push('no ETag');
  if (r.conditionalStatus !== 304) why.push(`conditional GET ${r.conditionalStatus == null ? 'not sent' : r.conditionalStatus} (want 304)`);
  if (r.cfCacheStatus) {
    const s = String(r.cfCacheStatus).toUpperCase();
    if (!EDGE_ASKED_ORIGIN.has(s)) why.push(`cf-cache-status ${s}: the edge did not ask the origin for this request`);
  } else if (r.cacheControl !== 'no-cache') {
    why.push(`no edge in front and Cache-Control is ${r.cacheControl == null ? 'absent' : JSON.stringify(r.cacheControl)} (want no-cache)`);
  }
  return { ok: why.length === 0, why: why.join('; ') };
}
