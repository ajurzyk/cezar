import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FORGEJO_MD = join(REPO_ROOT, '.ai/trackers/forgejo.md');
const GITHUB_MD = join(REPO_ROOT, '.ai/trackers/github.md');

/**
 * `.ai/trackers/forgejo.md` is executed, not merely read (#46).
 *
 * A tracker descriptor is documentation that runs: the ~30 `om-*` skills name an
 * operation and execute the block under its heading verbatim. So the only test
 * worth having is one that takes the block out of the markdown and runs it —
 * anything else pins a copy that drifts from the file the agent actually obeys.
 *
 * `tea` is replaced on `PATH` by a stub that records its argv and answers from a
 * canned script, so every case asserts on what the operation **sent**. There is
 * no network here, and an exit code alone is never the assertion: the whole
 * reason this descriptor exists in its current shape is that `tea api` exits 0
 * on an HTTP 404, so a passing exit status cannot distinguish a write that
 * landed from one that was never attempted.
 *
 * Every operation runs under `set -euo pipefail` — the harshest mode a caller
 * might impose, and the one that makes the SIGPIPE and `[ … ] && cmd` traps
 * this descriptor exists to avoid actually fire.
 */

const descriptor = readFileSync(FORGEJO_MD, 'utf8');

/** Every ```bash block in `text`. */
function bashBlocks(text: string): string[] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] as string);
}

/**
 * The helper definitions every operation assumes are in scope: every bash block
 * before `## Operations`. Keeping that rule mechanical is deliberate — a helper
 * added to the prose without a runnable block would silently not exist here, and
 * the case that needs it fails rather than quietly testing something else.
 */
const HELPERS = bashBlocks(descriptor.slice(0, descriptor.indexOf('\n## Operations'))).join('\n');

/** The first bash block under `#### <name>`, i.e. what a skill executes for that operation. */
function operation(name: string): string {
  const heading = `\n#### ${name}\n`;
  const start = descriptor.indexOf(heading);
  if (start < 0) throw new Error(`no #### ${name} in forgejo.md`);
  const rest = descriptor.slice(start + heading.length);
  const end = rest.search(/\n#{2,4} /);
  const blocks = bashBlocks(end < 0 ? rest : rest.slice(0, end));
  if (blocks.length === 0) throw new Error(`#### ${name} has no bash block`);
  return blocks.join('\n');
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** One entry per `tea` invocation, each the full argv. */
  calls: string[][];
}

describe('forgejo tracker descriptor (#46)', () => {
  let box: string;

  /**
   * `impl` is sh, receives the stub's argv, and answers with `reply <status> <body>`
   * — status line on stderr, body on stdout, exit 0. That is `tea api -i`'s real
   * shape, including the part that makes it dangerous.
   */
  const stubTea = (impl: string): void => {
    const bin = join(box, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'tea'),
      [
        '#!/bin/sh',
        // `tea --version` is not an API call: it answers from $TEA_VERSION_OUT,
        // which defaults to the real 0.15.1 line — ANSI escapes included,
        // because tea emits them through a pipe and that is what broke the
        // first version parse this descriptor shipped.
        'case "$1" in --version) printf "%b\\n" "${TEA_VERSION_OUT:-Version: \\033[1m0.15.1\\033[0m\\tgolang: 1.26.5}"; exit 0 ;; esac',
        'for a in "$@"; do printf "%s\\n" "$a" >> "$TEA_LOG"; done',
        'printf "<<call>>\\n" >> "$TEA_LOG"',
        'exec sh "$TEA_IMPL" "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'tea'), 0o755);
    writeFileSync(
      join(box, 'impl.sh'),
      [
        '#!/bin/sh',
        'reply() {',
        // Real headers are CRLF (Go's httputil.DumpResponse); the descriptor's
        // sed must cope with that, so the stub emits it.
        '  printf "HTTP/1.1 %s STATUS\\r\\nContent-Type: application/json\\r\\n\\r\\n" "$1" >&2',
        '  printf "%s" "$2"',
        '  exit 0',
        '}',
        'endpoint=""',
        'for a in "$@"; do case "$a" in /*) endpoint=$a ;; esac; done',
        impl,
        'reply 200 "{}"',
        '',
      ].join('\n'),
    );
  };

  const run = (body: string, env: Record<string, string> = {}): Promise<RunResult> =>
    new Promise((resolve) => {
      const log = join(box, 'tea.log');
      writeFileSync(log, '');
      execFile(
        'bash',
        ['-c', `set -euo pipefail\n${HELPERS}\n${body}`],
        {
          cwd: box,
          encoding: 'utf8',
          env: {
            PATH: `${join(box, 'bin')}:${process.env.PATH ?? ''}`,
            HOME: box,
            TMPDIR: box,
            TEA_LOG: log,
            TEA_IMPL: join(box, 'impl.sh'),
            REPO: 'ajr/orakton',
            LABELS_ENABLED: 'true',
            ...env,
          },
        },
        (err, stdout, stderr) => {
          const calls = readFileSync(log, 'utf8')
            .split('<<call>>\n')
            .filter((chunk) => chunk.trim() !== '')
            .map((chunk) => chunk.split('\n').slice(0, -1));
          resolve({
            code: (err as { code?: number } | null)?.code ?? 0,
            stdout,
            stderr,
            calls,
          });
        },
      );
    });

  beforeEach(() => {
    box = mkdtempSync(join(tmpdir(), 'cez-forgejo-'));
    stubTea('');
  });

  afterEach(() => rmSync(box, { recursive: true, force: true }));

  // ---------------------------------------------------------------- shape ---

  describe('shape', () => {
    it('carries a #### heading for every operation github.md names, in the same order', () => {
      const headings = (text: string) =>
        text.split('\n').filter((line) => line.startsWith('#### '));
      expect(headings(descriptor)).toEqual(headings(readFileSync(GITHUB_MD, 'utf8')));
      expect(headings(descriptor)).toHaveLength(42);
    });

    it('leaves no operation section empty', () => {
      const sections = descriptor.split(/\n(?=#### )/).slice(1);
      const empty = sections
        .map((section) => {
          const [heading, ...rest] = section.split('\n');
          return { heading, body: rest.join('\n').trim() };
        })
        .filter(({ body }) => body === '');
      expect(empty).toEqual([]);
    });

    it('states, for every operation, either a command or why there is none', () => {
      const sections = descriptor.split(/\n(?=#### )/).slice(1);
      const silent = sections
        .filter(
          (section) => !section.includes('```bash') && !/Not yet implemented — /.test(section),
        )
        .map((section) => section.split('\n')[0]);
      // Two headings are pure delegations to the guards, which are themselves
      // executable and tested below; everything else must ship a command.
      expect(silent).toEqual([
        '#### label-issue / unlabel-issue',
        '#### label-pr / unlabel-pr',
      ]);
    });
  });

  // -------------------------------------------------- identity and repo ---

  describe('identity and repository', () => {
    it('auth-check asks the API who we are rather than trusting a stored login', async () => {
      const result = await run(operation('auth-check'));

      expect(result.code).toBe(0);
      expect(result.calls[0]).toEqual([
        'api',
        '-i',
        '--repo',
        'ajr/orakton',
        '/user',
      ]);
    });

    it('auth-check reads the version through the colour codes tea emits', async () => {
      // Measured: `tea --version | cat -v` → `Version: ^[[1m0.15.1^[[0m<TAB>golang: …`.
      // A parse anchored on `Version: *[0-9]` matches nothing and warns about the
      // very client the descriptor was written against.
      const result = await run(operation('auth-check'));

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('WARNING');
      expect(result.stdout).not.toContain('unknown');
    });

    it('auth-check does warn about a client older than the tested one', async () => {
      const result = await run(operation('auth-check'), {
        TEA_VERSION_OUT: 'Version: \u001b[1m0.9.2\u001b[0m\tgolang: 1.21.0',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('0.9.2 predates 0.15.1');
    });

    it('auth-check fails when the credentials are rejected', async () => {
      stubTea('case "$endpoint" in /user) reply 401 \'{"message":"unauthorized"}\' ;; esac');

      const result = await run(operation('auth-check'));

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('401');
    });

    it('current-user reads the login out of the response', async () => {
      stubTea('case "$endpoint" in /user) reply 200 \'{"login":"cezar-bot"}\' ;; esac');

      const result = await run(`${operation('current-user')}\nprintf '%s' "$CURRENT_USER"`);

      expect(result.stdout).toBe('cezar-bot');
    });

    it('default-branch falls back to git when the API cannot answer', async () => {
      stubTea('reply 500 \'{"message":""}\'');

      const result = await run(`${operation('default-branch')}\nprintf '%s' "$BASE_BRANCH"`);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('main');
    });
  });

  // ------------------------------------------------------ tracker_repo ---

  describe('tracker_repo (#19, item 1: never let the client pick the repository)', () => {
    const remote = async (url: string) => {
      const repoDir = join(box, 'checkout');
      mkdirSync(repoDir, { recursive: true });
      await new Promise<void>((done) =>
        execFile('git', ['init', '-q', repoDir], () => done()),
      );
      await new Promise<void>((done) =>
        execFile('git', ['-C', repoDir, 'remote', 'add', 'origin', url], () => done()),
      );
      return run('cd checkout && tracker_repo', { REPO: '' });
    };

    it.each([
      ['ssh://git@forge.example:2222/ajr/orakton.git', 'ajr/orakton'],
      ['http://forge.example:8929/ajr/orakton.git', 'ajr/orakton'],
      ['git@forge.example:ajr/orakton.git', 'ajr/orakton'],
      ['http://user:pw@forge.example:8929/ajr/orakton', 'ajr/orakton'],
      // `%.git` before `%/` leaves `ajr/orakton.git`, which still matches the
      // `*/*` case and is returned as though it were a repository handle.
      ['http://forge.example:8929/ajr/orakton.git/', 'ajr/orakton'],
    ])('derives %s from origin itself', async (url, expected) => {
      expect((await remote(url)).stdout).toBe(expected);
    });

    it('prefers an explicit REPO over the checkout it happens to sit in', async () => {
      expect((await run('tracker_repo', { REPO: 'other/target' })).stdout).toBe('other/target');
    });

    it('stops rather than guessing when origin is not a forge URL', async () => {
      const result = await remote('/srv/dev/plain/repo.git');
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('is not owner/name');
    });
  });

  // ----------------------------------------------------------- tea_api ---

  describe('tea_api (the exit-code-0 trap)', () => {
    it('turns an HTTP error into a non-zero exit, which tea itself does not', async () => {
      stubTea('reply 404 \'{"message":"The target couldn\\u0027t be found."}\'');

      const result = await run("tea_api '/repos/{owner}/{repo}/pulls/9999'");

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('404');
    });

    it('reports a tea that never sent a request, instead of reading it as HTTP', async () => {
      // No status line at all — tea failing before the request goes out.
      stubTea("printf 'Error: login name does not exist\\n' >&2; exit 1");

      const result = await run("tea_api '/user'");

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('sent nothing');
      expect(result.stderr).not.toContain('HTTP');
    });

    it('addresses the resolved repository on every call', async () => {
      const result = await run("tea_api '/repos/{owner}/{repo}/labels' >/dev/null", {
        REPO: 'ajr/orakton',
      });

      expect(result.calls[0]).toContain('--repo');
      expect(result.calls[0]?.[result.calls[0].indexOf('--repo') + 1]).toBe('ajr/orakton');
    });
  });

  // ------------------------------------------------------ label guards ---

  describe('label guards', () => {
    /** A repo whose taxonomy spans more than one 50-item page. */
    const pagedLabels = (total: number) => `
      case "$endpoint" in
        */labels\\?page=1*) reply 200 "$(seq 1 50   | sed 's/.*/{"name":"label-&"}/' | paste -sd, - | sed 's/^/[/;s/$/]/')" ;;
        */labels\\?page=2*) reply 200 "$(seq 51 ${total} | sed 's/.*/{"name":"label-&"}/' | paste -sd, - | sed 's/^/[/;s/$/]/')" ;;
        */labels\\?page=*)  reply 200 '[]' ;;
      esac`;

    it('walks every page, so a label past the first 50 is not reported missing', async () => {
      stubTea(pagedLabels(60));

      const result = await run('label_exists label-57 && echo FOUND');

      expect(result.stdout.trim()).toBe('FOUND');
    });

    it('survives pipefail on a match, which the gh form does not (#19, item 3)', async () => {
      // github.md writes `gh api --paginate … | grep -Fxq "$1"`: grep exits on the
      // first match, the producer takes SIGPIPE, and under `set -o pipefail` a
      // label that DOES exist reports as missing. The first page is what makes
      // this bite — the producer is still writing when the reader leaves.
      stubTea(pagedLabels(60));

      const result = await run('if label_exists label-1; then echo FOUND; else echo MISSING; fi');

      expect(result.stdout.trim()).toBe('FOUND');
    });

    it('walks past a SHORT page, which is not the end of the list', async () => {
      // `[ "$_n" -lt 50 ] && break` reads like "that was the last page" and is
      // really "the server returned fewer than we asked for". `limit` is clamped
      // to the instance's MAX_RESPONSE_ITEMS (`tea api /settings/api` on the
      // tested instance: max_response_items 50, default_paging_num 30), so an
      // administrator who lowers it makes page one come back short — and every
      // label past it then reports as missing, which apply_label turns into a
      // silent "not defined in this repo" skip. Only an EMPTY page ends a list.
      stubTea(`
        case "$endpoint" in
          */labels\\?page=1*) reply 200 '[{"name":"label-a"},{"name":"label-b"}]' ;;
          */labels\\?page=2*) reply 200 '[{"name":"label-c"}]' ;;
          */labels\\?page=*)  reply 200 '[]' ;;
        esac`);

      const result = await run('label_exists label-c && echo FOUND');

      expect(result.stdout.trim()).toBe('FOUND');
    });

    it('reports a server that ignores ?page= instead of walking it forever', async () => {
      // Stopping only on the empty page trusts the server to paginate. A server
      // that does not would spin the walk against the network with no ceiling,
      // which is a worse failure than the truncation that condition replaced —
      // so the walk is bounded and hitting the bound is an error, never "the end".
      stubTea("case \"$endpoint\" in */labels\\?page=*) reply 200 '[{\"name\":\"same\"}]' ;; esac");

      const result = await run('tracker_labels_json', { TRACKER_LABEL_PAGES: '3' });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('not honouring ?page=');
      expect(result.calls).toHaveLength(3);
    });

    it('degrades to a logged skip for a label the repository does not define', async () => {
      stubTea(`
        case "$endpoint" in
          */labels\\?page=1*) reply 200 '[{"name":"bug"}]' ;;
          */labels\\?page=*)  reply 200 '[]' ;;
        esac`);

      const result = await run('apply_label needs-qa 12');

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Skipping label 'needs-qa'");
      // The skip must be a skip: no mutation went out.
      expect(result.calls.filter((call) => call.includes('POST'))).toEqual([]);
    });

    it('reports an unreadable taxonomy instead of skipping the label (#19, item 2)', async () => {
      stubTea('case "$endpoint" in */labels\\?page=*) reply 403 \'{"message":"forbidden"}\' ;; esac');

      const result = await run('apply_label review 12');

      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain('Skipping');
    });

    it('applies a label by name and reads it back out of the response (#19, item 4)', async () => {
      stubTea(`
        case "$endpoint" in
          */labels\\?page=1*) reply 200 '[{"name":"review"}]' ;;
          */labels\\?page=2*) reply 200 '[]' ;;
          */issues/12/labels) reply 200 '[{"name":"review"}]' ;;
        esac`);

      const result = await run('apply_label review 12');

      expect(result.code).toBe(0);
      const post = result.calls.find((call) => call.includes('POST'));
      expect(post).toEqual([
        'api',
        '-i',
        '--repo',
        'ajr/orakton',
        '-X',
        'POST',
        '/repos/{owner}/{repo}/issues/12/labels',
        '-F',
        'labels=["review"]',
      ]);
    });

    it('fails when the POST answers 200 without the label actually on the issue', async () => {
      // The exact shape the exit-code trap hides: a call that "succeeded" and
      // changed nothing.
      stubTea(`
        case "$endpoint" in
          */labels\\?page=1*) reply 200 '[{"name":"review"}]' ;;
          */labels\\?page=2*) reply 200 '[]' ;;
          */issues/12/labels) reply 200 '[]' ;;
        esac`);

      const result = await run('apply_label review 12');

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('did not land on #12');
    });

    it('url-encodes a label name on the removal path', async () => {
      stubTea('reply 204 ""');

      const result = await run("remove_label 'needs qa/now' 12");

      expect(result.code).toBe(0);
      expect(result.calls[0]).toContain('/repos/{owner}/{repo}/issues/12/labels/needs%20qa%2Fnow');
    });

    it('reports a failed removal instead of swallowing it (#19, item 2)', async () => {
      stubTea('reply 403 \'{"message":"forbidden"}\'');

      const result = await run('remove_label review 12');

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Failed to remove label 'review' from #12");
    });

    it('skips every label mutation when labels are disabled', async () => {
      const result = await run('apply_label review 12; remove_label qa 12', {
        LABELS_ENABLED: 'false',
      });

      expect(result.code).toBe(0);
      expect(result.calls).toEqual([]);
    });

    it('clears the other pipeline labels before setting one', async () => {
      stubTea(`
        case "$endpoint" in
          */labels\\?page=1*) reply 200 '[{"name":"review"}]' ;;
          */labels\\?page=2*) reply 200 '[]' ;;
          */issues/12/labels) reply 200 '[{"name":"review"}]' ;;
          *) reply 204 '' ;;
        esac`);

      const result = await run('set_pipeline_label 12 review', {
        PIPELINE_LABELS: 'review changes-requested qa merge-queue',
      });

      expect(result.code).toBe(0);
      const removed = result.calls
        .filter((call) => call.includes('DELETE'))
        .map((call) => call[call.length - 1]?.split('/').pop());
      expect(removed).toEqual(['changes-requested', 'qa', 'merge-queue']);
      expect(result.calls.some((call) => call.includes('POST'))).toBe(true);
    });
  });

  // ------------------------------------------------------------ issues ---

  describe('issues', () => {
    it('get-issue reads the issue and marks whether the number is a PR', async () => {
      stubTea(
        'reply 200 \'{"number":46,"title":"t","body":"b","state":"open","user":{"login":"ajr"},' +
          '"html_url":"http://f/i/46","labels":[{"name":"bug"}],"assignees":[],"comments":2,"pull_request":null}\'',
      );

      const result = await run(operation('get-issue'), { ISSUE: '46' });

      expect(result.calls[0]).toContain('/repos/{owner}/{repo}/issues/46');
      expect(JSON.parse(result.stdout)).toMatchObject({
        number: 46,
        state: 'OPEN',
        labels: ['bug'],
        isPullRequest: false,
      });
    });

    it('get-issue names the comment COUNT a count, because that is what Forgejo answers', async () => {
      // github.md's `comments` is the comment ARRAY; Forgejo's is an integer
      // (measured on ajr/cezar-qa: {"number":2,"comments":0}, type number).
      // Passing it through under github's name hands a caller scanning for the
      // 🤖 claim comment a number, so the shapes are kept distinguishable.
      stubTea(
        'reply 200 \'{"number":46,"title":"t","body":"b","state":"open","user":{"login":"ajr"},' +
          '"html_url":"http://f/i/46","labels":[],"assignees":[{"login":"cezar-bot"}],"comments":7,"pull_request":null}\'',
      );

      const parsed = JSON.parse((await run(operation('get-issue'), { ISSUE: '46' })).stdout);

      expect(parsed.commentCount).toBe(7);
      expect(parsed).not.toHaveProperty('comments');
      // The claim protocol's other two signals still come back from this one
      // operation, which is what keeps a lock detectable without the comment list.
      expect(parsed.assignees).toEqual(['cezar-bot']);
    });

    it('create-issue resolves label ids across pages, and names the ones it could not', async () => {
      // A single `?limit=50` here would answer "not defined in this repo" for the
      // 51st label — the same silent, wrong skip the label guard pages to avoid.
      const bodyFile = join(box, 'body.md');
      writeFileSync(bodyFile, 'body\n');
      stubTea(`
        case "$endpoint" in
          */labels\\?page=1*) reply 200 '[{"id":1,"name":"bug"}]' ;;
          */labels\\?page=2*) reply 200 '[{"id":2,"name":"needs-qa"}]' ;;
          */labels\\?page=*)  reply 200 '[]' ;;
          */issues)           reply 201 '{"html_url":"http://f/i/47"}' ;;
        esac`);

      const result = await run(operation('create-issue'), {
        ISSUE: '47',
        TITLE: 'a title',
        LOGIN: 'cezar-bot',
        LABELS: 'bug,needs-qa,no-such-label',
        BODY_FILE: bodyFile,
      });

      expect(result.code).toBe(0);
      const post = result.calls.find((call) => call.includes('POST'));
      expect(post).toContain('labels=[1,2]');
      // The log the operation's contract promises, which it did not emit.
      expect(result.stdout).toContain('Skipping labels not defined in this repo: no-such-label');
    });

    it('comment-issue sends a multi-line body through a file, never a command line', async () => {
      const bodyFile = join(box, 'body.md');
      writeFileSync(bodyFile, '# heading\n\nline one\nline two\n');
      stubTea('reply 201 \'{"html_url":"http://f/c/1"}\'');

      const result = await run(operation('comment-issue'), { ISSUE: '46', BODY_FILE: bodyFile });

      expect(result.calls[0]).toEqual([
        'api',
        '-i',
        '--repo',
        'ajr/orakton',
        '-X',
        'POST',
        '/repos/{owner}/{repo}/issues/46/comments',
        '-F',
        `body=@${bodyFile}`,
      ]);
      expect(result.stdout.trim()).toBe('http://f/c/1');
    });

    it('close-issue posts the closing comment before it changes the state', async () => {
      const bodyFile = join(box, 'body.md');
      writeFileSync(bodyFile, 'done in #51\n');
      stubTea('reply 200 \'{"state":"closed","html_url":"http://f/i/46"}\'');

      const result = await run(operation('close-issue'), { ISSUE: '46', BODY_FILE: bodyFile });

      // Order is the assertion: a comment lost to a failed PATCH is recoverable,
      // a closed issue with no explanation is not.
      expect(result.calls[0]).toContain('/repos/{owner}/{repo}/issues/46/comments');
      expect(result.calls[1]).toContain('PATCH');
      expect(result.calls[1]).toContain('state=closed');
    });

    it('assign-issue edits the existing assignee set instead of replacing it', async () => {
      // Forgejo has no add-assignee endpoint, so a naive PATCH would unassign
      // whoever claimed the issue first.
      stubTea(`
        case "$*" in
          *PATCH*) reply 200 '{}' ;;
          *) reply 200 '{"assignees":[{"login":"someone-else"}]}' ;;
        esac`);

      const result = await run(operation('assign-issue / unassign-issue'), {
        ISSUE: '46',
        LOGIN: 'cezar-bot',
      });

      const add = result.calls.find((call) => call.some((a) => a.startsWith('assignees=[')));
      expect(JSON.parse(add?.[add.indexOf('-F') + 1]?.slice('assignees='.length) ?? '[]')).toEqual([
        'cezar-bot',
        'someone-else',
      ]);
    });

    it('update-comment rewrites in place, which is what keeps 🤖 markers idempotent', async () => {
      const bodyFile = join(box, 'body.md');
      writeFileSync(bodyFile, '🤖 `om-auto-create-pr` — labels\n');
      stubTea('reply 200 \'{"html_url":"http://f/c/9"}\'');

      const result = await run(operation('update-comment'), {
        COMMENT_ID: '9',
        BODY_FILE: bodyFile,
      });

      expect(result.calls[0]).toContain('PATCH');
      expect(result.calls[0]).toContain('/repos/{owner}/{repo}/issues/comments/9');
    });
  });

  // ---------------------------------------------------- pull requests ---

  describe('pull requests', () => {
    const PR_JSON =
      '{"number":51,"title":"t","html_url":"http://f/p/51","body":"b","state":"open","merged":false,' +
      '"user":{"login":"ajr"},"draft":true,"base":{"ref":"main","sha":"aaa","repo":{"full_name":"ajr/orakton"}},' +
      '"head":{"ref":"feat/x","sha":"bbb","repo":{"full_name":"ajr/orakton"}},"mergeable":true,' +
      '"labels":[{"name":"review"}],"assignees":[],"created_at":"2026-08-26T10:00:00Z",' +
      '"merged_at":null,"closed_at":null,"additions":12,"changed_files":3}';

    /** The PR route plus the reviews route, which `get-pr` now also reads. */
    const stubPr = (prJson: string, reviewsJson = '[]'): void =>
      stubTea(`
        case "$endpoint" in
          */pulls/51/reviews) reply 200 '${reviewsJson}' ;;
          */pulls/51)         reply 200 '${prJson}' ;;
        esac`);

    it('get-pr serializes state the way TEMPLATE.md requires, not the way Forgejo answers', async () => {
      stubPr(PR_JSON);

      const result = await run(operation('get-pr'), { PR: '51' });

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        number: 51,
        state: 'OPEN',
        isDraft: true,
        headRefName: 'feat/x',
        isCrossRepository: false,
        additions: 12,
        changedFiles: 3,
      });
    });

    it('get-pr reports a merged PR as MERGED, which no Forgejo field says on its own', async () => {
      stubPr(
        PR_JSON.replace('"merged":false', '"merged":true').replace('"state":"open"', '"state":"closed"'),
      );

      const result = await run(operation('get-pr'), { PR: '51' });

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).state).toBe('MERGED');
    });

    it('get-pr answers every field skills request, so an omission is not found as a null', async () => {
      // The field list github.md documents IS the contract — om-auto-review-pr
      // step 2 names these. Nine of them were once silently absent from the
      // serialization while the prose accounted for two, which is the shape of
      // bug a key-set assertion catches and a per-field assertion does not.
      stubPr(PR_JSON);

      const result = await run(operation('get-pr'), { PR: '51' });

      expect(Object.keys(JSON.parse(result.stdout)).sort()).toEqual(
        [
          'additions', 'assignees', 'author', 'baseRefName', 'baseRefOid', 'body',
          'changedFiles', 'closedAt', 'commentCount', 'createdAt', 'headRefName',
          'headRefOid', 'headRepository', 'headRepositoryOwner', 'isCrossRepository',
          'isDraft', 'labels', 'latestReviews', 'maintainerCanModify', 'mergeCommit',
          'mergeStateStatus', 'mergeable', 'mergedAt', 'number', 'reviews', 'state',
          'title', 'url',
        ].sort(),
      );
    });

    it('get-pr reports a head that cannot merge in the words step 4a actually tests', async () => {
      // Forgejo answers a boolean. Passing it through under github.md's NAME
      // leaves `mergeable: false`, which is neither "CONFLICTING" nor "DIRTY", so
      // om-auto-review-pr step 4a never fires and a conflicted head is reviewed,
      // fixed and pushed as though it merged cleanly.
      stubPr(PR_JSON.replace('"mergeable":true', '"mergeable":false'));

      const result = await run(operation('get-pr'), { PR: '51' });

      const pr = JSON.parse(result.stdout);
      expect(pr.mergeable).toBe('CONFLICTING');
      expect(pr.mergeStateStatus).toBe('DIRTY');
    });

    it('get-pr calls a mergeable head UNKNOWN rather than CLEAN, which it cannot know', async () => {
      // Forgejo exposes one bit. "Not conflicting" is not "ready to merge": it
      // says nothing about behind/blocked/unstable, and a skill must not read
      // this descriptor's ignorance as a green light.
      stubPr(PR_JSON);

      const pr = JSON.parse((await run(operation('get-pr'), { PR: '51' })).stdout);
      expect(pr.mergeable).toBe('MERGEABLE');
      expect(pr.mergeStateStatus).toBe('UNKNOWN');
    });

    it('get-pr carries the reviews om-auto-review-pr needs to tell a re-review from a review', async () => {
      stubPr(
        PR_JSON,
        JSON.stringify([
          { state: 'REQUEST_CHANGES', dismissed: false, user: { login: 'ajr' }, body: 'first pass', submitted_at: '2026-08-26T10:00:00Z' },
          { state: 'APPROVED', dismissed: false, user: { login: 'ajr' }, body: 'now good', submitted_at: '2026-08-26T12:00:00Z' },
          { state: 'PENDING', dismissed: false, user: { login: 'other' }, body: 'draft', submitted_at: '2026-08-26T13:00:00Z' },
        ]),
      );

      const pr = JSON.parse((await run(operation('get-pr'), { PR: '51' })).stdout);

      // PENDING is an unsubmitted draft, not a verdict, so it is not a review.
      expect(pr.reviews.map((r: { state: string }) => r.state)).toEqual([
        'CHANGES_REQUESTED',
        'APPROVED',
      ]);
      // latestReviews is the newest submitted review per author.
      expect(pr.latestReviews).toEqual([
        { author: 'ajr', body: 'now good', submittedAt: '2026-08-26T12:00:00Z', state: 'APPROVED' },
      ]);
    });

    it('get-pr never lets an unknown review state read as APPROVED', async () => {
      stubPr(
        PR_JSON,
        JSON.stringify([
          { state: 'SOME_FUTURE_STATE', dismissed: false, user: { login: 'ajr' }, body: '', submitted_at: '2026-08-26T10:00:00Z' },
        ]),
      );

      const pr = JSON.parse((await run(operation('get-pr'), { PR: '51' })).stdout);
      expect(pr.reviews[0].state).toBe('UNRECOGNIZED');
    });

    it('create-pr sends the WIP prefix for a draft and proves the instance took it', async () => {
      const bodyFile = join(box, 'body.md');
      writeFileSync(bodyFile, 'Closes #46\n');
      stubTea('reply 201 \'{"number":51,"html_url":"http://f/p/51","draft":true}\'');

      const result = await run(
        `${operation('create-pr')}\nprintf '%s %s' "$PR_NUMBER" "$PR_URL"`,
        { DRAFT: 'true', TITLE: 'Add the thing', HEAD_BRANCH: 'feat/x', BASE_BRANCH: 'main', BODY_FILE: bodyFile },
      );

      expect(result.code).toBe(0);
      expect(result.calls[0]).toContain('title=WIP: Add the thing');
      expect(result.stdout).toBe('51 http://f/p/51');
    });

    it('create-pr fails loudly when the instance did not honour the WIP prefix', async () => {
      const bodyFile = join(box, 'body.md');
      writeFileSync(bodyFile, 'Closes #46\n');
      stubTea('reply 201 \'{"number":51,"html_url":"http://f/p/51","draft":false}\'');

      const result = await run(operation('create-pr'), {
        DRAFT: 'true',
        TITLE: 'Add the thing',
        HEAD_BRANCH: 'feat/x',
        BASE_BRANCH: 'main',
        BODY_FILE: bodyFile,
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('is NOT a draft');
    });

    it('mark-pr-ready strips the prefix and proves draft actually flipped', async () => {
      stubTea(`
        if [ -f "$HOME/patched" ]; then
          reply 200 '{"title":"Add the thing","draft":false}'
        else
          case "$*" in
            *PATCH*) touch "$HOME/patched"; reply 200 '{}' ;;
            *) reply 200 '{"title":"WIP: Add the thing","draft":true}' ;;
          esac
        fi`);

      const result = await run(operation('mark-pr-ready'), { PR: '51' });

      expect(result.code).toBe(0);
      const patch = result.calls.find((call) => call.includes('PATCH'));
      expect(patch).toContain('title=Add the thing');
    });

    it.each([['WIP: t'], ['[WIP] t'], ['wip: t'], ['[wip] t']])(
      'mark-pr-ready strips %s, the whole of Gitea default prefix list',
      async (title) => {
        stubTea(`
          case "$*" in
            *PATCH*) reply 200 '{}' ;;
            *) reply 200 '{"title":"${title}","draft":false}' ;;
          esac`);

        const result = await run(operation('mark-pr-ready'), { PR: '51' });

        expect(result.calls.find((call) => call.includes('PATCH'))).toContain('title=t');
      },
    );

    it('mark-pr-ready fails loudly when the retitle left the PR a draft', async () => {
      // The failure this read-back exists for: the instance's configured prefix
      // list is not the default one, and the API does not expose it.
      stubTea(`
        case "$*" in
          *PATCH*) reply 200 '{}' ;;
          *) reply 200 '{"title":"WIP: t","draft":true}' ;;
        esac`);

      const result = await run(operation('mark-pr-ready'), { PR: '51' });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('still a draft');
    });

    it('review-pr surfaces a self-review rejection instead of working around it', async () => {
      const bodyFile = join(box, 'body.md');
      writeFileSync(bodyFile, 'lgtm\n');
      stubTea('reply 422 \'{"message":"approve your own pull is not allowed"}\'');

      const result = await run(
        "tea_api -X POST '/repos/{owner}/{repo}/pulls/51/reviews' -f 'event=APPROVED' -F \"body=@$BODY_FILE\"",
        { BODY_FILE: bodyFile },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('approve your own pull is not allowed');
    });

    it('merge-pr reads back whether the merge actually happened', async () => {
      stubTea(`
        case "$*" in
          *POST*) reply 200 '' ;;
          *) reply 200 '{"merged":true,"merged_at":"2026-08-26T12:00:00Z"}' ;;
        esac`);

      const result = await run(operation('merge-pr'), { PR: '51' });

      expect(result.calls[0]).toContain('Do=squash');
      expect(JSON.parse(result.stdout)).toEqual({
        merged: true,
        mergedAt: '2026-08-26T12:00:00Z',
      });
    });

    it('get-pr-checks distinguishes "no CI ran" from "CI passed"', async () => {
      stubTea(`
        case "$endpoint" in
          */pulls/51) reply 200 '{"head":{"sha":"bbb"}}' ;;
          */statuses*) reply 200 '[]' ;;
          */status) reply 200 '{"state":"","total_count":0}' ;;
        esac`);

      const result = await run(operation('get-pr-checks'), { PR: '51' });

      // total 0 is "no signal" — a caller that reads this as green is the bug the
      // operation's prose warns about.
      expect(result.stdout).toContain('"total": 0');
    });

    it('get-required-checks treats unreadable branch protection as "everything is required"', async () => {
      stubTea('reply 404 \'{"message":"The target couldn\\u0027t be found."}\'');

      // No `|| true` here on purpose. 404 is the MEASURED default on the tested
      // instance (`/branch_protections/main` → 404), and the operation's own
      // prose promises it degrades to "every reported check is required". A
      // block that instead exits non-zero takes the calling skill down with it
      // under `set -euo pipefail`, so the degradation has to live in the
      // descriptor rather than in whatever the caller happens to append.
      const result = await run(`${operation('get-required-checks')}\necho AFTER`, {
        BASE_BRANCH: 'main',
      });

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('AFTER');
    });

    it('checkout-pr names the repository rather than letting tea infer it', async () => {
      const result = await run(operation('checkout-pr'), { PR: '51' });

      expect(result.calls[0]).toEqual([
        'pulls',
        'checkout',
        '51',
        '--repo',
        'ajr/orakton',
        '--branch',
      ]);
    });

    it('list-review-comments asks for the fields a reviewer needs, resolver included', async () => {
      const result = await run(operation('list-review-comments'), { PR: '51' });

      expect(result.calls[0]).toContain('review-comments');
      expect(result.calls[0]).toContain('ajr/orakton');
      expect(result.calls[0]?.[result.calls[0].length - 1]).toContain('resolver');
    });
  });

  // ---------------------------------------------- review-state dictionary ---

  describe('review_decision', () => {
    const reviews = (states: string[]) =>
      `case "$endpoint" in */reviews) reply 200 '${JSON.stringify(
        states.map((state) => ({ state, dismissed: false })),
      )}' ;; esac`;

    it.each([
      [['APPROVED'], 'approved'],
      [['REQUEST_CHANGES'], 'changes-requested'],
      [['COMMENT'], 'review-required'],
      [['APPROVED', 'REQUEST_CHANGES'], 'changes-requested'],
      [['PENDING'], 'review-required'],
      [['REQUEST_REVIEW'], 'review-required'],
    ])('maps %s to %s', async (states, expected) => {
      stubTea(reviews(states));

      const result = await run('review_decision 51');

      expect(JSON.parse(result.stdout).decision).toBe(expected);
    });

    it('never lets a state outside the dictionary become approved', async () => {
      // The dictionary is derived from Gitea's sources, not from the wire, so a
      // version that adds a state is a real possibility. forgejo-map.ts:482 makes
      // the same call: unrecognized means review-required, and it is flagged.
      stubTea(reviews(['APPROVED', 'SOME_FUTURE_STATE']));

      const result = await run('review_decision 51');

      expect(JSON.parse(result.stdout)).toEqual({
        decision: 'review-required',
        unrecognized: true,
      });
    });

    it('treats a dismissed approval as dismissed, not as an approval', async () => {
      stubTea(
        'case "$endpoint" in */reviews) reply 200 \'[{"state":"APPROVED","dismissed":true}]\' ;; esac',
      );

      const result = await run('review_decision 51');

      expect(JSON.parse(result.stdout).decision).toBe('review-required');
    });
  });

  // -------------------------------------------------- image evidence ---

  describe('attach-image-evidence', () => {
    /** A stub `curl` that records its argv and answers like the /assets endpoint. */
    const stubCurl = (assetJson: string): void => {
      const bin = join(box, 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, 'curl'),
        [
          '#!/bin/sh',
          'for a in "$@"; do printf "%s\\n" "$a" >> "$CURL_LOG"; done',
          'printf "<<call>>\\n" >> "$CURL_LOG"',
          'case "$*" in',
          '  */api/v1/user) printf \'{"login":"cezar-bot"}\' ;;',
          `  *assets) printf '%s' '${assetJson}' ;;`,
          '  *) printf "{}" ;;',
          'esac',
          '',
        ].join('\n'),
      );
      chmodSync(join(bin, 'curl'), 0o755);
    };

    const setup = (opts: { images: string[]; maxSize?: number; maxFiles?: number }) => {
      mkdirSync(join(box, '.config/tea'), { recursive: true });
      writeFileSync(
        join(box, '.config/tea/config.yml'),
        [
          'logins:',
          '- name: other',
          '  url: http://wrong:1/',
          '  token: wrong-token',
          '  default: false',
          '- name: q7010',
          '  url: http://forge.example:8929',
          '  token: right-token',
          '  default: true',
          '',
        ].join('\n'),
      );
      const bodyFile = join(box, 'body.md');
      writeFileSync(bodyFile, 'QA evidence for #51\n');
      stubTea(`
        case "$endpoint" in
          /settings/attachment) reply 200 '{"enabled":true,"max_size":${opts.maxSize ?? 2048},"max_files":${opts.maxFiles ?? 5},"allowed_types":".png,.jpg"}' ;;
          /user) reply 200 '{"login":"cezar-bot"}' ;;
          *comments) reply 201 '{"html_url":"http://forge.example:8929/p/51#c9"}' ;;
        esac`);
      return { bodyFile };
    };

    const curlCalls = () =>
      readFileSync(join(box, 'curl.log'), 'utf8')
        .split('<<call>>\n')
        .filter((chunk) => chunk.trim() !== '')
        .map((chunk) => chunk.split('\n').slice(0, -1));

    it('uploads through /assets and embeds a URL the agent can actually reach', async () => {
      const { bodyFile } = setup({ images: [] });
      stubCurl(
        '{"id":2,"name":"shot.png","browser_download_url":"http://forge.example.local:8929/attachments/uuid-1"}',
      );
      const shot = join(box, 'shot.png');
      writeFileSync(shot, Buffer.alloc(1024));

      const result = await run(operation('attach-image-evidence'), {
        PR: '51',
        IMAGES: shot,
        BODY_FILE: bodyFile,
        CURL_LOG: join(box, 'curl.log'),
      });

      expect(result.code).toBe(0);
      const upload = curlCalls().find((call) => call.some((a) => a.endsWith('/assets')));
      expect(upload).toContain(`attachment=@${shot}`);
      expect(upload).toContain('Authorization: token right-token');
      // `browser_download_url` carries the instance's ROOT_URL — a third host
      // spelling that does not resolve from the agent's network. The comment must
      // carry the host that just authenticated.
      const posted = readFileSync(`${bodyFile}.evidence`, 'utf8');
      expect(posted).toContain('![shot.png](http://forge.example:8929/attachments/uuid-1)');
      expect(posted).not.toContain('forge.example.local');
    });

    it('takes its credentials from the default login, not the first one in the file', async () => {
      const { bodyFile } = setup({ images: [] });
      stubCurl('{"browser_download_url":"http://forge.example:8929/attachments/uuid-1"}');
      const shot = join(box, 'shot.png');
      writeFileSync(shot, Buffer.alloc(16));

      await run(operation('attach-image-evidence'), {
        PR: '51',
        IMAGES: shot,
        BODY_FILE: bodyFile,
        CURL_LOG: join(box, 'curl.log'),
      });

      const tokens = curlCalls().flat().filter((a) => a.startsWith('Authorization:'));
      expect(tokens.every((a) => a === 'Authorization: token right-token')).toBe(true);
      expect(tokens).not.toHaveLength(0);
    });

    it('still comments, saying what it could not attach, when a file is over the limit', async () => {
      const { bodyFile } = setup({ images: [], maxSize: 1 });
      stubCurl('{"browser_download_url":"http://forge.example:8929/attachments/uuid-1"}');
      const big = join(box, 'big.png');
      writeFileSync(big, Buffer.alloc(4096));

      const result = await run(operation('attach-image-evidence'), {
        PR: '51',
        IMAGES: big,
        BODY_FILE: bodyFile,
        CURL_LOG: join(box, 'curl.log'),
      });

      // TEMPLATE.md:59 — never fail the caller; say what happened.
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('http://forge.example:8929/p/51#c9');
      const posted = readFileSync(`${bodyFile}.evidence`, 'utf8');
      expect(posted).toContain('**Not attached:**');
      expect(posted).toContain('big.png');
      expect(curlCalls().some((call) => call.some((a) => a.endsWith('/assets')))).toBe(false);
    });

    it('degrades the same way for a type the instance does not allow', async () => {
      const { bodyFile } = setup({ images: [] });
      stubCurl('{"browser_download_url":"http://forge.example:8929/attachments/uuid-1"}');
      const svg = join(box, 'diagram.svg');
      writeFileSync(svg, '<svg/>');

      const result = await run(operation('attach-image-evidence'), {
        PR: '51',
        IMAGES: svg,
        BODY_FILE: bodyFile,
        CURL_LOG: join(box, 'curl.log'),
      });

      expect(result.code).toBe(0);
      expect(readFileSync(`${bodyFile}.evidence`, 'utf8')).toContain('diagram.svg');
      expect(curlCalls().some((call) => call.some((a) => a.endsWith('/assets')))).toBe(false);
    });

    it('stops at the instance’s max_files rather than sending a sixth upload', async () => {
      const { bodyFile } = setup({ images: [], maxFiles: 2 });
      stubCurl('{"browser_download_url":"http://forge.example:8929/attachments/uuid-1"}');
      const shots = ['a', 'b', 'c'].map((name) => {
        const path = join(box, `${name}.png`);
        writeFileSync(path, Buffer.alloc(64));
        return path;
      });

      const result = await run(operation('attach-image-evidence'), {
        PR: '51',
        IMAGES: shots.join(' '),
        BODY_FILE: bodyFile,
        CURL_LOG: join(box, 'curl.log'),
      });

      expect(result.code).toBe(0);
      expect(curlCalls().filter((call) => call.some((a) => a.endsWith('/assets')))).toHaveLength(2);
      expect(readFileSync(`${bodyFile}.evidence`, 'utf8')).toContain('c.png');
    });
  });

  // -------------------------------------------------------------- CI ---

  describe('CI runs', () => {
    it('list-runs asks for the branch it was given', async () => {
      stubTea('reply 200 \'{"workflow_runs":[{"id":7,"name":"ci","status":"completed","conclusion":"success","head_sha":"bbb","html_url":"http://f/r/7","created_at":"2026-08-26T10:00:00Z"}],"total_count":1}\'');

      const result = await run(operation('list-runs'), { BRANCH: 'feat/x' });

      expect(result.calls[0]?.[result.calls[0].length - 1]).toContain('branch=feat/x');
      expect(JSON.parse(result.stdout)[0]).toMatchObject({ databaseId: 7, conclusion: 'success' });
    });

    it('list-runs answers an empty list for a repo with no Actions, never a green verdict', async () => {
      stubTea('reply 200 \'{"workflow_runs":[],"total_count":0}\'');

      const result = await run(operation('list-runs'), { BRANCH: 'feat/x' });

      expect(JSON.parse(result.stdout)).toEqual([]);
    });

    it('get-run-failed-logs fetches only the jobs that failed', async () => {
      stubTea(`
        case "$endpoint" in
          */runs/7/jobs) reply 200 '{"jobs":[{"id":1,"conclusion":"success"},{"id":2,"conclusion":"failure"}]}' ;;
          */jobs/2/logs) reply 200 'the failing output' ;;
        esac`);

      const result = await run(operation('get-run-failed-logs'), { RUN_ID: '7' });

      expect(result.stdout).toContain('=== job 2 ===');
      expect(result.stdout).not.toContain('=== job 1 ===');
      expect(result.calls.some((call) => call.includes('/repos/{owner}/{repo}/actions/jobs/1/logs'))).toBe(false);
    });

    it('watch-run stops on a completed run and reports its conclusion', async () => {
      stubTea('reply 200 \'{"status":"completed","conclusion":"failure"}\'');

      const result = await run(operation('watch-run'), {
        RUN_ID: '7',
        CI_MAX_WAIT_MINUTES: '1',
      });

      // The operation's exit status IS the verdict, so a red run must be non-zero.
      expect(result.code).not.toBe(0);
      // Two calls: the poll that saw `completed`, and the conclusion read. A
      // third would mean it kept sleeping past a finished run.
      expect(result.calls).toHaveLength(2);
    });

    it('watch-run gives up at the configured budget instead of blocking forever', async () => {
      stubTea('reply 200 \'{"status":"running","conclusion":null}\'');

      const result = await run(operation('watch-run'), {
        RUN_ID: '7',
        // Already spent: the loop must not enter even once.
        CI_MAX_WAIT_MINUTES: '0',
      });

      expect(result.code).not.toBe(0);
      expect(result.calls).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------- labels ---

  describe('labels', () => {
    it('list-labels returns every page', async () => {
      stubTea(`
        case "$endpoint" in
          */labels\\?page=1*) reply 200 "$(seq 1 50 | sed 's/.*/{"name":"l&"}/' | paste -sd, - | sed 's/^/[/;s/$/]/')" ;;
          */labels\\?page=2*) reply 200 '[{"name":"l51"}]' ;;
          */labels\\?page=*)  reply 200 '[]' ;;
        esac`);

      const result = await run(operation('list-labels'));

      expect(result.stdout.trim().split('\n')).toHaveLength(51);
      expect(result.stdout).toContain('l51');
    });

    it('ensure-label-taxonomy creates only the labels that are missing', async () => {
      stubTea(`
        case "$endpoint" in
          */labels\\?page=1*) reply 200 '[{"name":"review"},{"name":"bug"}]' ;;
          */labels\\?page=2*) reply 200 '[]' ;;
          */labels) reply 201 '{"name":"created"}' ;;
        esac`);

      const result = await run(operation('ensure-label-taxonomy'));

      expect(result.code).toBe(0);
      const created = result.calls
        .filter((call) => call.includes('POST'))
        .map((call) => call[call.indexOf('-f') + 1]);
      expect(created).not.toContain('name=review');
      expect(created).not.toContain('name=bug');
      expect(created).toContain('name=needs-qa');
      // The 27-label taxonomy minus the two that already exist.
      expect(created).toHaveLength(25);
    });

    it('ensure-label-taxonomy refuses to create blind when the taxonomy is unreadable', async () => {
      // `label_exists` answers 2 for "could not read the taxonomy", which is not
      // the same as "missing" — `apply_label` already separates the two. Treating
      // 2 as missing here creates every label a second time, and Forgejo does not
      // stop it: measured 2026-08-26 on ajr/cezar-qa (both probes deleted after),
      // POST /labels with a name that already exists answers `201` with a fresh
      // id, leaving two labels sharing one name.
      stubTea(`
        case "$endpoint" in
          */labels\\?page=*) reply 500 '{"message":"boom"}' ;;
          */labels) reply 201 '{"name":"created"}' ;;
        esac`);

      const result = await run(operation('ensure-label-taxonomy'));

      expect(result.code).not.toBe(0);
      expect(result.calls.filter((call) => call.includes('POST'))).toEqual([]);
    });

    it('create-label sends the colour the caller gave it', async () => {
      stubTea('reply 201 \'{"name":"risk-high"}\'');

      const result = await run(operation('create-label'), {
        LABEL: 'risk-high',
        COLOR: 'b60205',
        DESCRIPTION: 'Wide blast radius, review deeply',
      });

      expect(result.calls[0]).toContain('name=risk-high');
      expect(result.calls[0]).toContain('color=b60205');
    });
  });
});
