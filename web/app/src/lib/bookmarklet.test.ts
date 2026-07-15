import { describe, expect, it } from 'vitest'

import { BOOKMARKLET_PORTS, bookmarkletUrl } from './bookmarklet'

/** The program text a browser would actually execute when the bookmarklet is clicked. */
const program = (url: string) => decodeURIComponent(url.replace(/^javascript:/, ''))

describe('bookmarkletUrl (spec 011, protected /new deep-link contract)', () => {
  it('is a javascript: URL wrapping one URI-encoded expression', () => {
    const url = bookmarkletUrl('om-fix', true, 'sekret')
    expect(url.startsWith('javascript:')).toBe(true)
    // The raw URL carries no whitespace or double quotes — it must survive a bookmarks bar.
    expect(url).not.toMatch(/[\s"]/)
  })

  it('the generic launcher (no skill) omits skill= and never auto-starts', () => {
    const code = program(bookmarkletUrl('', false, 'sekret'))
    expect(code).toContain(`q='auto=0&key=sekret&ref='`)
    expect(code).not.toContain('skill=')
  })

  it('a per-skill launcher bakes skill=, the auto flag and the launch key into /new', () => {
    const code = program(bookmarkletUrl('om-fix', true, 'sekret'))
    expect(code).toContain(`q='skill=om-fix&auto=1&key=sekret&ref='`)
    expect(code).toContain(`'/new?'+q`)
  })

  it('the page URL rides along as ref= at click time', () => {
    const code = program(bookmarkletUrl('om-fix', false, 'k'))
    expect(code).toContain(`ref='+encodeURIComponent(location.href)`)
  })

  it("escapes apostrophes in skill and key — they would break the embedded '…' string", () => {
    const code = program(bookmarkletUrl("bob's-skill", false, "k'ey"))
    expect(code).toContain('skill=bob%27s-skill')
    expect(code).toContain('key=k%27ey')
    // No stray apostrophe beyond the intentional string delimiters around the query.
    expect(code).toContain(`q='skill=bob%27s-skill&auto=0&key=k%27ey&ref='`)
  })

  it('probes the documented cockpit port range via the CORS-open /api/health', () => {
    const code = program(bookmarkletUrl('', false, ''))
    expect(code).toContain(`[${BOOKMARKLET_PORTS.join(',')}]`)
    expect(BOOKMARKLET_PORTS[0]).toBe(4321)
    expect(BOOKMARKLET_PORTS).toHaveLength(10)
    expect(code).toContain(`'/api/health'`)
  })

  it('only fires on GitHub PR/issue pages and matches the repo by remote', () => {
    const code = program(bookmarkletUrl('', false, ''))
    expect(code).toContain('github\\.com')
    expect(code).toContain('(pull|issues)')
    expect(code).toContain('r.remote.includes(m[1]+') // repo-matching cockpit wins
  })
})
