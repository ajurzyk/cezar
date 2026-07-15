/**
 * The bookmarklet generator (spec 011), ported verbatim from the legacy cockpit
 * (`web/app.js`): the `javascript:` URL a user drags to the bookmarks bar. Clicked on a
 * GitHub PR/issue it probes localhost:4321–4330 for running cockpits (`GET /api/health` —
 * the one CORS-open route), picks the one whose `repo.remote` matches the page's owner/repo
 * (fallback: first alive) and opens `/new?skill=&auto=&key=&ref=` there.
 *
 * That deep-link query grammar is a PROTECTED contract (BACKWARD_COMPATIBILITY.md §1):
 * bookmarklets users saved from the legacy cockpit and ones generated here must speak the
 * same `/new` language. The whole program is one URI-encoded expression — no external state.
 *
 * `alert()` inside the generated code is deliberate and stays: the program runs on
 * github.com, where the cockpit's toaster and design system do not exist (the design
 * guardian carries the matching file allowance).
 */

/** The port range the generated program scans — the cockpit's default port plus nine. */
export const BOOKMARKLET_PORTS = [4321, 4322, 4323, 4324, 4325, 4326, 4327, 4328, 4329, 4330]

export function bookmarkletUrl(skillName: string, auto: boolean, key: string): string {
  // `'` survives encodeURIComponent — it would break the single-quoted JS string below.
  const enc = (s: string) => encodeURIComponent(s).replaceAll("'", '%27')
  const query = `${skillName ? `skill=${enc(skillName)}&` : ''}auto=${auto ? '1' : '0'}&key=${enc(key)}&ref=`
  const code =
    `(async()=>{const m=location.href.match(/^https:\\/\\/github\\.com\\/([^\\/]+)\\/([^\\/]+)\\/(pull|issues)\\/\\d+/);` +
    `if(!m){alert('Open a GitHub PR or issue first');return;}` +
    `const q='${query}'+encodeURIComponent(location.href);` +
    `const f=async p=>{try{const c=new AbortController();setTimeout(()=>c.abort(),800);` +
    `const r=await fetch('http://localhost:'+p+'/api/health',{signal:c.signal});const h=await r.json();` +
    `return{p,remote:(h.repo&&h.repo.remote)||''}}catch(e){return null}};` +
    `const rs=(await Promise.all([${BOOKMARKLET_PORTS.join(',')}].map(f))).filter(Boolean);` +
    `if(!rs.length){alert('cezar cockpit is not running - start it with: npx cezar');return;}` +
    `const t=rs.find(r=>r.remote.includes(m[1]+'/'+m[2]))||rs[0];` +
    `open('http://localhost:'+t.p+'/new?'+q,'_blank');})();`
  return `javascript:${encodeURIComponent(code)}`
}
