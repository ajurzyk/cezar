import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * The Forgejo surface, end to end — the case #25's UI QA could not run (#26).
 *
 * Two things had to exist before a browser could reach any Forgejo behaviour at all, and both
 * landed with this spec:
 *
 *  1. Fixtures. Under `CEZ_DRY_RUN=1` the Forgejo driver reported the forge AVAILABLE and then
 *     served empty lists, so the tab rendered healthy and held nothing — no row to click, no
 *     detail pane, no hand-off panel. `forgejo.ts`'s dry-run catalog is what fills it.
 *  2. A project the forge seam actually classifies as Forgejo. The host table outranks a repo
 *     config by design (`classifyForgeKind`), so the cezar checkout itself — a github.com
 *     remote — can never be one. This spec builds its own: a scratch repo whose remote sits on a
 *     host the table cannot name, plus a `forge` block in its `.ai/cezar/config.json`.
 *
 * Why a spec-owned server rather than the shared env: this spec STARTS A RUN, and the shared
 * env's run list must not grow side effects (`github.e2e.ts`'s standing rule). The same reason
 * `variants-compare.e2e.ts` boots its own. The env's own Forgejo project
 * (`.ai/scripts/test-env-up.sh`) is for QA and manual demo, and the run-wide `globalSetup`
 * (`workspace-registry.ts`) trims it away for the duration of a vitest run anyway.
 *
 * Nothing here contacts a forge. `forgejo.test` is the reserved TLD, and under dry-run those URLs
 * are only ever read for classification and link composition.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-forgejo-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

/** The forge this project declares. `webUrl` is what every fixture item URL must be built on —
 *  the property #26 turns on ("never `github.com`"). */
const FORGE = {
  kind: 'forgejo',
  apiUrl: 'http://forgejo.test:3000',
  webUrl: 'https://forgejo.test',
} as const
const REMOTE = 'https://forgejo.test/mock-forge/dry-run-demo.git'
const ITEM_URL_PREFIX = 'https://forgejo.test/mock-forge/dry-run-demo/'

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the Forgejo fixture server never answered at ${url}`)
}

interface HealthPayload {
  forge: { kind: string; available: boolean } | null
}

interface GithubItemPayload {
  number: number
  title: string
  url: string
  labels: string[]
}

interface GithubPayload {
  available: boolean
  repo?: string
  issues: GithubItemPayload[]
  prs: GithubItemPayload[]
}

interface RunPayload {
  id: string
  title: string
  task: string
  issueNumber?: number
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const scoped = (path: string) => `/p/${bootProject}${path}`

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`)
  if (!res.ok) throw new Error(`cezar e2e: GET ${path} answered ${res.status}`)
  return (await res.json()) as T
}

beforeAll(async () => {
  // A REAL git repo: `resolveForge` builds `owner`/`repo` from the remote alone, and starting a
  // run needs a repo to branch from.
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-forgejo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  git('remote', 'add', 'origin', REMOTE)
  writeFileSync(join(dataRoot, 'README.md'), '# forgejo e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  mkdirSync(join(dataRoot, '.ai/cezar'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/config.json'), `${JSON.stringify({ forge: FORGE }, null, 2)}\n`, 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
}, 120_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('a Forgejo project against a live dry-run server', () => {
  it('the forge seam resolves this project to the Forgejo driver, offline and tokenless', async () => {
    const health = await api<HealthPayload>('/api/v1/health')
    // Not merely "some forge": the whole point is that this is NOT the GitHub driver. The env
    // carries no CEZ_FORGEJO_TOKEN and reaches no network — availability comes from the dry-run
    // probe, exactly as it does for GitHub.
    expect(health.forge).toEqual({ kind: 'forgejo', available: true })
  })

  it('/api/v1/github serves populated lists whose URLs sit on the configured webUrl host', async () => {
    const gh = await api<GithubPayload>('/api/v1/github')

    expect(gh.available).toBe(true)
    expect(gh.repo).toBe('mock-forge/dry-run-demo')
    // The regression #26 names: `available:true` with `items:[]` left nothing to click.
    expect(gh.issues.length).toBeGreaterThan(0)
    expect(gh.prs.length).toBeGreaterThan(0)
    for (const item of [...gh.issues, ...gh.prs]) {
      expect(item.url.startsWith(ITEM_URL_PREFIX)).toBe(true)
      expect(item.url).not.toContain('github.com')
    }
  })

  it('lists issues and PRs, and opens an issue’s detail pane', async () => {
    const gh = await api<GithubPayload>('/api/v1/github')
    const first = gh.issues[0]
    expect(first).toBeDefined()
    if (!first) return

    browser.goto(`${baseUrl}${scoped('/github')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-header"]') !== null`)
    // Bare `/github` restores the last-selected tab (#417) — pin it to Issues rather than assume.
    browser.click(`[data-slot="gh-tabs"] a[href="${scoped('/github')}"]`)
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="gh-row"]').length === ${gh.issues.length}`,
    )
    expect(browser.text('[data-slot="gh-tabs"]')).toContain(`Pull requests · ${gh.prs.length}`)

    browser.click(`[data-slot="gh-row"][data-number="${first.number}"]`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-detail-inner"]') !== null`)
    expect(browser.url()).toBe(`${baseUrl}${scoped(`/github/issues/${first.number}`)}`)
    expect(browser.text('[data-slot="gh-detail-inner"] h2')).toBe(first.title)
    expect(browser.text('[data-slot="gh-meta"]')).toContain(`#${first.number}`)
    browser.screenshot(`${artifactsDir}/forgejo-detail.png`)
  })

  it('a hand-off carrying ONLY the item’s Forgejo URL still reaches the agent with its reference', async () => {
    const gh = await api<GithubPayload>('/api/v1/github')
    const item = gh.issues[0]
    expect(item).toBeDefined()
    if (!item) return

    browser.goto(`${baseUrl}${scoped(`/github/issues/${item.number}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="gh-hand"]') !== null`)

    // The case #25 fixed and could not prove in a browser: an item URL is NOT a reference. The
    // extractor's tier 1 is spelled `github.com` and nothing else, so a Forgejo URL is recovered by
    // no tier at all — `composeGithubTask` therefore has to prepend the ref block rather than treat
    // the URL as already-carried context. `fill` replaces the pre-filled block, so what the box
    // holds here is the URL alone.
    browser.fill('[data-slot="gh-custom-prompt"]', item.url)
    // The Run button is held until the registry has named the forge (`forgeHeld`) — the prompt has
    // to say "Forgejo", not "GitHub". Poll for the release rather than sampling it.
    browser.waitForFunction(
      `document.querySelector('[data-action="gh-run"]')?.disabled === false`,
    )
    browser.click('[data-action="gh-run"]')

    browser.waitForFunction(`document.querySelector('[data-slot="gh-view-run"]') !== null`)
    const href = String(browser.evaluate(`document.querySelector('[data-slot="gh-view-run"]').getAttribute('href')`))
    const runId = href.split('/').pop() ?? ''
    expect(runId).not.toBe('')

    const run = await api<RunPayload>(`/api/v1/runs/${runId}`)
    // The reference block, in the FORGE'S OWN wording — "fix GitHub issue #N" about a Forgejo issue
    // is simply false, and it is also what the extractor's tier-2 patterns key on.
    expect(run.task.startsWith(`Fix Forgejo issue #${item.number}: ${item.title}`)).toBe(true)
    expect(run.task).toContain(item.url)
    // …and the attribution that block exists to carry: `extractTaskRefs` recovered the number, so
    // the task table paints its issue chip and the title leads with `#N`.
    expect(run.issueNumber).toBe(item.number)
    expect(run.title.startsWith(`${item.number}: `)).toBe(true)

    browser.screenshot(`${artifactsDir}/forgejo-handoff.png`)
  })
})
