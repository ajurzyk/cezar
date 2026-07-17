/**
 * The bookmarklet generator (spec 011): the `javascript:` URL a user drags to the bookmarks
 * bar. Clicked on a GitHub PR/issue it opens the cockpit's `/new?skill=&auto=&key=&ref=` deep
 * link — the cockpit that GENERATED the bookmarklet, whose origin is baked in at generation.
 *
 * Why no localhost port-scan probe anymore: the legacy program fetched
 * `http://localhost:4321-4330/api/health` from github.com to discover a running cockpit and pick
 * the one serving the page's repo. GitHub's Content-Security-Policy (`default-src 'none'` + a
 * fixed `connect-src` allowlist) BLOCKS any fetch/XHR to localhost from the page context a
 * bookmarklet runs in, so every probe throws "Failed to fetch" and the launcher wrongly reported
 * "cockpit is not running" even with a cockpit up (verified against GitHub's live CSP, 2026-07).
 * A top-level navigation (`window.open`) is NOT subject to `connect-src`, so we open the cockpit
 * directly. Baking the generating origin also makes it exact: the bookmarklet opens the very
 * cockpit you saved it from — no guessing the port, and multi-repo users get the right one for
 * free (each cockpit stamps its own origin).
 *
 * The `/new?skill=&auto=&key=&ref=` deep-link grammar is a PROTECTED contract
 * (BACKWARD_COMPATIBILITY.md §1) and is unchanged — only the client-side discovery is.
 *
 * `alert()` in the generated code is deliberate: the program runs on github.com, where the
 * cockpit's toaster does not exist (the design guardian carries the matching file allowance).
 */

/** The cockpit's default origin — the fallback when a caller can't supply `window.location.origin`. */
export const DEFAULT_COCKPIT_ORIGIN = 'http://localhost:4321'

export function bookmarkletUrl(
  skillName: string,
  auto: boolean,
  key: string,
  origin: string = DEFAULT_COCKPIT_ORIGIN,
): string {
  // `'` survives encodeURIComponent — it would break the single-quoted JS strings below.
  const enc = (s: string) => encodeURIComponent(s).replaceAll("'", '%27')
  const query = `${skillName ? `skill=${enc(skillName)}&` : ''}auto=${auto ? '1' : '0'}&key=${enc(key)}&ref=`
  // Keep the origin's `://` intact (do NOT URI-encode it — it goes straight into `open()`); only
  // neutralize a stray apostrophe so it can't break the embedded string.
  const base = origin.replaceAll("'", '%27')
  const code =
    `(()=>{const m=location.href.match(/^https:\\/\\/github\\.com\\/([^\\/]+)\\/([^\\/]+)\\/(pull|issues)\\/\\d+/);` +
    `if(!m){alert('Open a GitHub PR or issue first');return;}` +
    `const q='${query}'+encodeURIComponent(location.href);` +
    `open('${base}/new?'+q,'_blank');})();`
  return `javascript:${encodeURIComponent(code)}`
}
