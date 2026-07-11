'use strict';

/* cez cockpit v2 — vanilla JS, no build step. Talks to the local server via
   fetch + Server-Sent Events. Layout: a persistent sidebar (new task, nav,
   run list, env footer) + one main view per tab. */

const $ = (sel, el = document) => el.querySelector(sel);

const state = {
  runs: new Map(),        // id -> RunRecord
  selectedId: null,
  runEs: null,            // per-run EventSource
  lastSeq: 0,             // dedup across SSE reconnect replays
  autoScroll: true,
  workflows: [],
  taskSource: 'workflow', // 'workflow' (a chain) | 'skill' — what taskRef names
  taskRef: null,          // selected chain/skill name (the "≡ fix-and-verify" pill)
  taskModel: '',          // model override ('' = auto; the "⊞ auto" pill)
  modelsAvailable: false, // claude CLI detected → model menu lists Claude models
  srcMenuTab: 'workflow', // Workflows | Skills tab inside the source pill menu
  srcMenuQuery: '',       // search box inside the source pill menu
  pendingImages: [],      // [{mediaType, data, preview}] queued for the next message
  taskImages: [],         // screenshots pasted into the new-task form
  listView: 'active',     // 'active' | 'archived'
  todos: [],              // global inbox entries (spec 007)
  plan: null,             // {task, steps, rationale, fallback} — proposed chain (spec 008)
  planDragIdx: null,      // index of the plan step being dragged
  variants: 1,            // ×1/×2/×3 switch — parallel variants (spec 010)
  expandedGroups: new Set(), // groupIds expanded in the run list
  selectedGroupId: null,  // group shown in the compare view (instead of a run)
  launchKey: null,        // bookmarklet auto-start secret (spec 011), lazy-fetched
  bmAuto: true,           // "One-click launch (auto-submit)" checkbox
  bmFilter: '',           // per-skill bookmarklet filter text
  theme: document.documentElement.dataset.theme || 'dark',
  // GitHub tab
  gh: null,               // /api/github payload
  ghFull: false,          // true once the "everything open" fetch landed
  ghFullLoading: false,
  ghView: 'issues',       // 'issues' | 'prs'
  ghSel: null,            // selected item url
  ghWorkflow: null,       // workflow chip (null = none — skills/quick-task run)
  ghSkills: new Set(),    // skill names toggled on
  ghSkillQuery: '',       // filter over the skill chips (long catalogs)
  ghQueued: new Map(),    // item url -> run id (client-side "queued" marker)
  lastGhRun: null,
  // Skills tab
  skillsList: null,       // /api/skills payload (shared with the GitHub tab chips)
  skillSel: null,         // selected skill name, or '__bm' for the bookmarklet panel
  skillQuery: '',
  // Workflows tab — the builder canvas (spec 012)
  wb: null,               // {name, description, steps, query, importOpen, importText, importError, copied}
  wbDrag: null,           // {from:'palette', skill} | {from:'step', index}
};

const STATUS_ORDER = { waiting: 0, review: 1, running: 2, queued: 3 };

// ---- helpers ---------------------------------------------------------------

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* Compact form for the run list — "2m", "1h", "3d". */
function shortAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtTokens(n) {
  if (!n) return '0 tok';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${n} tok`;
}

function fmtCost(usd) {
  if (!usd) return '';
  return `$${usd >= 10 ? usd.toFixed(0) : usd.toFixed(2)}`;
}

/* Queue position among queued runs (FIFO = createdAt order) — spec 006. */
function queuePosition(run) {
  const queued = [...state.runs.values()]
    .filter((r) => !r.archived && r.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const idx = queued.findIndex((r) => r.id === run.id);
  return idx >= 0 ? idx + 1 : null;
}

const STATUS_LABEL = {
  waiting: 'needs you',
  review: 'needs review',
  running: 'running',
  queued: 'queued',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

function statusPill(run) {
  const status = run.status;
  const pulse = status === 'waiting' || status === 'running' || status === 'review';
  let label = STATUS_LABEL[status] ?? status;
  if (status === 'queued') {
    const pos = queuePosition(run);
    if (pos) label += ` #${pos}`;
  }
  return `<span class="pill ${esc(status)}">${pulse ? '<span class="pulse-dot"></span>' : ''}${esc(label)}</span>`;
}

function prLink(run) {
  if (!run.pullRequestUrl) return '';
  const num = run.pullRequestUrl.split('/').pop();
  return `<a href="${esc(run.pullRequestUrl)}" target="_blank" rel="noopener">PR #${esc(num)}</a>`;
}

/* ---- parallel variants (spec 010) ---- */

const TERMINAL_STATUSES = ['done', 'failed', 'review', 'cancelled'];

/* Group title = any variant's title without its " (A)" suffix. */
function groupTitle(run) {
  return run.title.replace(/ \([A-C]\)$/, '');
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

/* Minimal unified-diff renderer (spec 009) — shared by the "± Diff" panel and
   the review gate. Text parsing only: `diff --git` starts a collapsible
   per-file <details>, +/− lines get colored, @@ hunks and file meta dim.
   Non-diff text (degradation notes) renders as a plain <pre>. ZERO libs. */
function renderDiff(text) {
  const raw = String(text ?? '').trimEnd();
  if (!raw.trim()) return '<div class="dim">(no changes)</div>';
  if (!raw.includes('diff --git ')) return `<pre>${esc(raw)}</pre>`;
  const out = [];
  let file = null; // { name, lines }
  const flush = () => {
    if (!file) return;
    out.push(
      `<details class="diff-file" open><summary>${esc(file.name)}</summary><pre>${file.lines.join('\n')}</pre></details>`,
    );
    file = null;
  };
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const m = / b\/(.+)$/.exec(line);
      file = { name: m ? m[1] : line.slice(11), lines: [] };
      continue;
    }
    if (!file) continue; // preamble before the first file header
    let cls = '';
    if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-meta';
    else if (line.startsWith('@@')) cls = 'diff-hunk';
    else if (line.startsWith('+')) cls = 'diff-add';
    else if (line.startsWith('-')) cls = 'diff-del';
    else if (/^(index |new file|deleted file|old mode|new mode|similarity|rename |copy |Binary files)/.test(line)) cls = 'diff-meta';
    file.lines.push(cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line));
  }
  flush();
  return out.join('');
}

/* Tiny markdown renderer for the handoff notes — headings, bold, inline code,
   fenced code, lists, links, hr. Escape-first, line-based, ZERO libs. Not a
   full parser; handoff files are simple and anything unrecognized falls
   through as a plain paragraph. */
function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let code = null; // collected fenced-code lines
  let quote = false; // inside a > blockquote
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const closeQuote = () => {
    if (quote) {
      out.push('</blockquote>');
      quote = false;
    }
  };
  const inline = (s) => {
    let h = esc(s);
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    return h;
  };
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      closeList();
      closeQuote();
      code = [];
      continue;
    }
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      if (!quote) {
        closeList();
        out.push('<blockquote>');
        quote = true;
      }
      if (bq[1].trim()) out.push(`<p>${inline(bq[1])}</p>`);
      continue;
    }
    closeQuote();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      const content = (ul ?? ol)[1];
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(content);
      out.push(
        task
          ? `<li class="task"><span class="cb">${task[1].trim() ? '☑' : '☐'}</span>${inline(task[2])}</li>`
          : `<li>${inline(content)}</li>`,
      );
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); // unclosed fence
  closeList();
  closeQuote();
  return out.join('\n');
}

// ---- boot ------------------------------------------------------------------

async function init() {
  bindUi();
  applyTheme(state.theme);
  const [health, workflowsRes, runs, todos, skills, uiState] = await Promise.all([
    getJson('/api/health'),
    getJson('/api/workflows'),
    getJson('/api/runs'),
    getJson('/api/todos').catch(() => []),
    getJson('/api/skills').catch(() => []), // the form's skill mode + GitHub chips
    getJson('/api/ui-state').catch(() => ({})),
  ]);
  state.todos = todos;
  state.skillsList = skills;
  renderInboxBadge();
  renderChrome(health);
  // Preselect what you actually run: the last-used source (persisted in
  // .ai/cezar/ui-state.json), else the first skill, else the first workflow.
  const last = uiState.lastTask;
  const lastValid =
    last &&
    (last.source === 'skill'
      ? skills.some((s) => s.name === last.ref)
      : workflowsRes.workflows.some((w) => w.name === last.ref));
  const pick = lastValid ? last : defaultTaskSource(workflowsRes.workflows);
  state.taskSource = pick.source;
  state.taskRef = pick.ref;
  setWorkflowOptions(workflowsRes.workflows);
  for (const run of runs) state.runs.set(run.id, run);
  renderRunList();
  connectGlobal();
  const deepLinked = await handleDeepLink();
  if (!deepLinked) {
    const latest = sortedRuns()[0];
    if (latest) selectRun(latest.id);
  }
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('cez-theme', theme);
  } catch {
    // private mode — the toggle still works for this page
  }
  const btn = $('#theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? 'LIGHT ☼' : 'DARK ☾';
}

// ---- bookmarklet deep-link (spec 011) ----------------------------------------

/* `/new?skill=<name>&ref=<github-url>&auto=1&key=<launchKey>` — opened by a
   bookmarklet clicked on a GitHub PR/issue. `auto=1` + the correct launch-key
   starts the run immediately; anything else (no auto, bad key, a drive-by
   page guessing the URL) only prefills the form — the user presses Run.
   Returns true when a run was started (and selected). */
async function handleDeepLink() {
  const params = new URLSearchParams(location.search);
  if (location.pathname !== '/new' && !params.has('skill') && !params.has('ref')) return false;
  const skill = (params.get('skill') ?? '').trim();
  const ref = (params.get('ref') ?? params.get('task') ?? '').trim();
  const auto = params.get('auto') === '1';
  const key = params.get('key') ?? '';
  history.replaceState({}, '', '/'); // never re-trigger on reload
  if (!ref) return false;

  if (auto) {
    let launchKey = '';
    try {
      launchKey = (await getJson('/api/launch-key')).key;
    } catch {
      // fall through to the blocked path
    }
    if (launchKey && key === launchKey) {
      // Per-skill: one inline step (the spec-008 API); no skill: quick-task.
      const body = skill
        ? { steps: [{ id: 'task', name: skill, skill, prompt: ref }], task: ref }
        : { workflow: 'quick-task', task: ref };
      try {
        const res = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        handleStarted(data);
        alertBar(skill ? `Started "${skill}" on ${oneLine(ref)}` : `Started task on ${oneLine(ref)}`);
        return true;
      } catch (err) {
        alertBar(`Auto-start failed: ${err.message} — review the form and press Run`);
      }
    } else {
      alertBar('auto-launch blocked (bad key) — press Run');
    }
  }

  // Prefill path: the form carries everything; quick-task (or the planner)
  // resolves a named skill from the task text — zero extra UI.
  const form = $('#new-task');
  form.task.value = skill ? `Use the "${skill}" skill on: ${ref}` : ref;
  if (state.workflows.some((w) => w.name === 'quick-task')) {
    state.taskSource = 'workflow';
    state.taskRef = 'quick-task';
    renderTaskPills();
  }
  if (!auto) alertBar('Form prefilled from GitHub — review & press Run');
  $('#run-btn').focus();
  return false;
}

/* Skills first (feedback 2026-07-11): the natural default is a skill, not a
   chain — workflows stay one tab away in the picker. */
function defaultTaskSource(workflows = state.workflows) {
  const firstSkill = (state.skillsList ?? [])[0];
  if (firstSkill) return { source: 'skill', ref: firstSkill.name };
  return { source: 'workflow', ref: workflows[0]?.name ?? 'quick-task' };
}

function setWorkflowOptions(workflows) {
  state.workflows = workflows;
  const refValid =
    state.taskRef &&
    (state.taskSource === 'skill'
      ? (state.skillsList ?? []).some((s) => s.name === state.taskRef)
      : state.workflows.some((w) => w.name === state.taskRef));
  if (!refValid) {
    const pick = defaultTaskSource(workflows);
    state.taskSource = pick.source;
    state.taskRef = pick.ref;
  }
  renderTaskPills();
  // GitHub's workflow chip is optional (null = run skills or quick-task) —
  // only clear it when it names a workflow that no longer exists.
  if (state.ghWorkflow && !state.workflows.some((w) => w.name === state.ghWorkflow)) {
    state.ghWorkflow = null;
  }
}

/* Remember what was just run so the next session preselects it. Fire-and-
   forget — a failed write only costs the convenience. */
function saveLastTaskSource() {
  if (!state.taskRef) return;
  void fetch('/api/ui-state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lastTask: { source: state.taskSource, ref: state.taskRef } }),
  }).catch(() => {});
}

/* ---- the form's pill dropdowns — "≡ fix-and-verify ⌄" and "⊞ auto ⌄" ---- */

const PILL_ICONS = {
  chain: 'M4 6h16M4 12h16M4 18h10', // ≡ list
  skill: 'M4 19.5A2.5 2.5 0 016.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z', // book
  model: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M6 6h12v12H6z', // chip
};

/* Small inline icons for the run-detail action bar (design: every action has
   a glyph, not typography like "±" / "▶"). Stroke icons by default; `fill`
   for solid play/stop. */
function biIcon(d, fill = false) {
  return `<svg class="bi${fill ? ' bi-fill' : ''}" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
}
const BI = {
  check: biIcon('M5 12l5 5 9-11'),
  play: biIcon('M6 4l14 8-14 8V4z', true),
  stop: biIcon('M7 7h10v10H7z', true),
  terminal: biIcon('M4 17l6-5-6-5M12 19h8'),
  diff: biIcon('M9 5v6M6 8h6M6 16h6M16 5v14'),
  notes: biIcon('M6 3h9l4 4v14H6V3zM15 3v4h4M9 12h7M9 16h5'),
  folder: biIcon('M3 8a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8zM9 14h6'),
  archive: biIcon('M4 5h16v4H4zM6 9v10h12V9M10 13h4'),
  trash: biIcon('M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13M10 11v6M14 11v6'),
};

function pillHtml(iconPath, label, menuHtml) {
  return `
    <button type="button" class="pill-btn">
      <svg class="pic" viewBox="0 0 24 24"><path d="${iconPath}"/></svg>
      <span class="pl">${esc(label)}</span>
      <svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="pill-menu" hidden>${menuHtml}</div>`;
}

function menuItemHtml(data, title, desc, selected, iconPath) {
  return `
    <div class="menu-item ${selected ? 'on' : ''}" ${data}>
      <div class="mi-title"><span class="chk">${selected ? '✓' : ''}</span>${
        iconPath ? `<svg class="mi-ic" viewBox="0 0 24 24"><path d="${iconPath}"/></svg>` : ''
      }${esc(title)}</div>
      ${desc ? `<div class="mi-desc">${esc(desc)}</div>` : ''}
    </div>`;
}

/* One pill covers chains AND skills: a search box + a Workflows|Skills tab
   inside the menu ("zero new concepts": you pick what runs, the kind is
   implicit in where you found it). */
function srcMenuItemsHtml() {
  const q = state.srcMenuQuery.trim().toLowerCase();
  const items =
    state.srcMenuTab === 'skill'
      ? (state.skillsList ?? []).map((s) => ({ name: s.name, desc: s.description, source: 'skill' }))
      : state.workflows.map((w) => ({ name: w.name, desc: w.description, source: 'workflow' }));
  const filtered = items.filter(
    (i) => !q || i.name.toLowerCase().includes(q) || (i.desc ?? '').toLowerCase().includes(q),
  );
  if (!filtered.length) {
    return `<div class="menu-empty">${
      state.srcMenuTab === 'skill' && !(state.skillsList ?? []).length
        ? 'No skills yet — drop Markdown files into .ai/skills/'
        : '(nothing matches)'
    }</div>`;
  }
  return filtered
    .map((i) =>
      menuItemHtml(
        `data-mi="src" data-source="${i.source}" data-value="${esc(i.name)}"`,
        i.name,
        i.desc,
        state.taskSource === i.source && state.taskRef === i.name,
        i.source === 'skill' ? SKILL_ICON : PILL_ICONS.chain,
      ),
    )
    .join('');
}

function renderTaskPills() {
  const srcMenu = `
    <div class="menu-search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg>
      <input id="src-search" type="text" placeholder="Search…" autocomplete="off">
    </div>
    <div class="menu-tabs">
      <button type="button" data-mtab="workflow" class="${state.srcMenuTab === 'workflow' ? 'active' : ''}">Workflows</button>
      <button type="button" data-mtab="skill" class="${state.srcMenuTab === 'skill' ? 'active' : ''}">Skills</button>
    </div>
    <div id="src-menu-items">${srcMenuItemsHtml()}</div>`;
  $('#src-pill').innerHTML = pillHtml(
    state.taskSource === 'skill' ? PILL_ICONS.skill : PILL_ICONS.chain,
    state.taskRef ?? 'quick-task',
    srcMenu,
  );

  const models = state.modelsAvailable ? CLAUDE_MODELS : CLAUDE_MODELS.slice(0, 1);
  const selectedModel = models.find((m) => m.id === state.taskModel) ?? models[0];
  const modelMenu = models
    .map((m) =>
      menuItemHtml(
        `data-mi="model" data-value="${esc(m.id)}"`,
        m.label,
        m.desc,
        m.id === (selectedModel?.id ?? ''),
        PILL_ICONS.model,
      ),
    )
    .join('');
  $('#model-pill').innerHTML = pillHtml(PILL_ICONS.model, selectedModel?.label ?? 'auto', modelMenu);
}

function closePillMenus() {
  for (const el of document.querySelectorAll('.pill-select.open')) {
    el.classList.remove('open');
    const menu = el.querySelector('.pill-menu');
    if (menu) menu.hidden = true;
  }
}

function renderChrome(health) {
  const repoChip = $('#repo-chip');
  repoChip.hidden = false;
  repoChip.textContent = health.repo
    ? `${health.repo.root.split('/').pop()} / ${health.repo.branch}`
    : 'no git — tasks run in place';
  repoChip.title = health.repo ? `${health.repo.root} · ${health.repo.branch}` : 'not a git repo — tasks run in place, one at a time';
  $('#env-chips').innerHTML = health.checks
    .map(
      (c) =>
        `<span class="env-chip ${c.available ? 'ok' : 'bad'}" title="${esc(c.hint ?? c.version ?? '')}"><span class="led"></span>${esc(c.name)}</span>`,
    )
    .join('');

  // Model pill fed by what's actually connected: claude CLI present → the
  // Claude catalog; otherwise only "auto".
  state.modelsAvailable = health.checks.some((c) => c.name === 'claude' && c.available);
  renderTaskPills();
}

/* What `claude --model` accepts: "auto" (no flag — each step decides), the
   stable tier aliases (they track the newest release), then current pinned
   versions for reproducible runs. */
const CLAUDE_MODELS = [
  { id: '', label: 'auto', desc: 'Pick the best model per step' },
  { id: 'opus', label: 'opus', desc: 'Deep reasoning for hard tasks' },
  { id: 'sonnet', label: 'sonnet', desc: 'Fast and cheap' },
  { id: 'haiku', label: 'haiku', desc: 'Fastest — simple, scoped tasks' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', desc: 'Pinned version' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', desc: 'Pinned version' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', desc: 'Pinned version' },
];

/* The global stream replays nothing after a drop (laptop sleep, server
   restart) — a missed `run` event would leave a stale status in the sidebar
   forever (seen live: a run resting at `review` still listed under Working).
   Every (re)connect and every return to a visible tab re-syncs the full run
   list instead. */
let lastResyncAt = 0;
async function resyncRuns() {
  if (Date.now() - lastResyncAt < 2_000) return; // boot + onopen double-fire guard
  lastResyncAt = Date.now();
  try {
    const runs = await getJson('/api/runs');
    const fresh = new Set(runs.map((r) => r.id));
    for (const id of [...state.runs.keys()]) if (!fresh.has(id)) state.runs.delete(id);
    for (const run of runs) state.runs.set(run.id, run);
    renderRunList();
    const sel = state.selectedId ? state.runs.get(state.selectedId) : null;
    if (sel) {
      updateDetail(sel);
    } else if (state.selectedId) {
      state.selectedId = null;
      $('#detail').innerHTML = '<div class="empty">Select a run — or start one.</div>';
    }
  } catch {
    // offline — the next reconnect/visibility flip retries
  }
}

function connectGlobal() {
  const es = new EventSource('/api/events');
  es.onopen = () => void resyncRuns(); // fires on the initial connect AND every auto-reconnect
  document.addEventListener('visibilitychange', () => {
    // SSE can die silently across a sleep — a tab coming back re-syncs too.
    if (!document.hidden) void resyncRuns();
  });
  es.addEventListener('run', (e) => {
    const run = JSON.parse(e.data);
    state.runs.set(run.id, run);
    renderRunList();
    if (run.id === state.selectedId) updateDetail(run);
  });
  es.addEventListener('run-deleted', (e) => {
    const { id } = JSON.parse(e.data);
    state.runs.delete(id);
    renderRunList();
    if (id === state.selectedId) {
      state.selectedId = null;
      $('#detail').innerHTML = '<div class="empty">Select a run — or start one.</div>';
    }
  });
  es.addEventListener('todos', (e) => {
    state.todos = JSON.parse(e.data);
    renderInboxBadge();
    if (!$('#view-inbox').hidden) renderInbox();
  });
}

// ---- UI events -------------------------------------------------------------

function bindUi() {
  $('#theme-toggle').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    for (const b of $('#tabs').children) b.classList.toggle('active', b === btn);
    for (const view of document.querySelectorAll('.view')) view.hidden = true;
    const view = $(`#view-${btn.dataset.view}`);
    view.hidden = false;
    if (btn.dataset.view === 'repo') loadRepo();
    if (btn.dataset.view === 'skills') loadSkills();
    if (btn.dataset.view === 'inbox') renderInbox();
    if (btn.dataset.view === 'github') loadGithub();
    if (btn.dataset.view === 'workflows') openWorkflowsView();
  });

  $('#view-inbox').addEventListener('click', async (e) => {
    const goto = e.target.closest('[data-goto-run]');
    if (goto) {
      e.preventDefault();
      showRunsView();
      selectRun(goto.dataset.gotoRun);
      return;
    }
    const btn = e.target.closest('button[data-todo-action]');
    if (!btn) return;
    const id = btn.closest('.todo-card')?.dataset.id;
    if (!id) return;
    if (btn.dataset.todoAction === 'remove') {
      await fetch(`/api/todos/${id}`, { method: 'DELETE' });
      state.todos = state.todos.filter((t) => t.id !== id);
      renderInboxBadge();
      renderInbox();
    } else if (btn.dataset.todoAction === 'start') {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/todos/${id}/start`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        const todo = state.todos.find((t) => t.id === id);
        if (todo) todo.startedTaskId = data.run.id;
        renderInboxBadge();
        renderInbox();
        state.runs.set(data.run.id, data.run);
        showRunsView();
        renderRunList();
        selectRun(data.run.id);
      } catch (err) {
        alertBar(err.message);
        btn.disabled = false;
      }
    }
  });

  bindGithubView();
  bindSkillsView();
  bindWorkflowsView();
  bindRepoView();

  const taskForm = $('#new-task');

  // Pill dropdowns: toggle on the pill, select on a menu item, close on any
  // outside click (one document listener; menus are re-rendered per change).
  document.addEventListener('click', (e) => {
    const pill = e.target.closest('.pill-select');
    if (!pill) {
      closePillMenus();
      return;
    }
    const item = e.target.closest('.menu-item[data-mi]');
    if (item) {
      if (item.dataset.mi === 'src') {
        state.taskSource = item.dataset.source;
        state.taskRef = item.dataset.value;
      } else if (item.dataset.mi === 'model') {
        state.taskModel = item.dataset.value;
      }
      closePillMenus();
      renderTaskPills();
      return;
    }
    // Workflows | Skills switch inside the source menu.
    const mtab = e.target.closest('button[data-mtab]');
    if (mtab) {
      state.srcMenuTab = mtab.dataset.mtab;
      for (const b of mtab.parentElement.children) b.classList.toggle('active', b === mtab);
      const box = $('#src-menu-items');
      if (box) box.innerHTML = srcMenuItemsHtml();
      $('#src-search')?.focus();
      return;
    }
    if (e.target.closest('.menu-search')) return; // typing, not toggling
    if (e.target.closest('.pill-btn')) {
      const menu = pill.querySelector('.pill-menu');
      const wasOpen = pill.classList.contains('open');
      closePillMenus();
      if (!wasOpen && menu) {
        pill.classList.add('open');
        menu.hidden = false;
        // Fresh view on open: Skills tab by default (feedback 2026-07-11 —
        // skills are what people pick 9 times out of 10), empty query,
        // focused search.
        if (pill.id === 'src-pill') {
          state.srcMenuTab = 'skill';
          state.srcMenuQuery = '';
          const search = $('#src-search');
          if (search) search.value = '';
          for (const b of menu.querySelectorAll('button[data-mtab]')) {
            b.classList.toggle('active', b.dataset.mtab === state.srcMenuTab);
          }
          const box = $('#src-menu-items');
          if (box) box.innerHTML = srcMenuItemsHtml();
          search?.focus();
        }
      }
    }
  });

  // Live filter — re-render only the item list so the input keeps focus.
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'src-search') return;
    state.srcMenuQuery = e.target.value;
    const box = $('#src-menu-items');
    if (box) box.innerHTML = srcMenuItemsHtml();
  });
  // Enter in the search picks the first match (and never submits the form).
  document.addEventListener('keydown', (e) => {
    if (e.target.id !== 'src-search' || e.key !== 'Enter') return;
    e.preventDefault();
    $('#src-menu-items .menu-item')?.click();
  });

  // 📎 — attach images to the task (same pipeline as ⌘V paste).
  const taskFile = $('#task-file');
  $('#task-attach').addEventListener('click', () => taskFile.click());
  taskFile.addEventListener('change', () => {
    for (const file of taskFile.files ?? []) {
      void readImageFile(file).then((img) => {
        if (!img || state.taskImages.length >= 4) return;
        state.taskImages.push(img);
        renderTaskThumbs();
      });
    }
    taskFile.value = '';
  });

  // ⌘↵ / Ctrl+↵ submits from inside the textarea.
  taskForm.task.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      taskForm.requestSubmit();
    }
  });

  // The task box grows on focus and with content, springs back when left
  // empty. Explicit px heights so the CSS height transition animates.
  const taskBox = taskForm.task;
  const autosizeTask = () => {
    const engaged = document.activeElement === taskBox || taskBox.value.trim();
    const floor = engaged ? 92 : 40;
    const prev = taskBox.style.height || '40px';
    taskBox.style.height = 'auto';
    const target = Math.max(floor, Math.min(taskBox.scrollHeight, 220));
    taskBox.style.height = prev; // restore the start point…
    void taskBox.offsetHeight; //   …force a reflow…
    taskBox.style.height = `${target}px`; // …then animate to the target
  };
  taskBox.addEventListener('focus', autosizeTask);
  taskBox.addEventListener('input', autosizeTask);
  taskBox.addEventListener('blur', autosizeTask);

  // Drop target for GitHub rows (and any dragged text): prefill the task box
  // with the dragged prompt, then pick a skill/workflow and press Run.
  taskBox.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('text/plain')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  taskBox.addEventListener('drop', (e) => {
    const text = e.dataTransfer?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    taskBox.value = text;
    taskBox.focus();
    taskBox.dispatchEvent(new Event('input')); // autosize to the content
  });

  // Screenshots pasted into the task box travel with POST /api/runs and reach
  // the first agent step's opening message.
  taskBox.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items ?? [])].filter((i) => i.type.startsWith('image/'));
    if (!items.length) return;
    e.preventDefault();
    for (const item of items) {
      const file = item.getAsFile();
      if (file) {
        void readImageFile(file).then((img) => {
          if (!img || state.taskImages.length >= 4) return;
          state.taskImages.push(img);
          renderTaskThumbs();
        });
      }
    }
  });
  $('#task-thumbs').addEventListener('click', (e) => {
    const thumb = e.target.closest('[data-idx]');
    if (!thumb) return;
    state.taskImages.splice(Number(thumb.dataset.idx), 1);
    renderTaskThumbs();
  });

  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const errorBox = $('#form-error');
    errorBox.hidden = true;
    const body = {
      task: form.task.value.trim(),
      model: state.taskModel || undefined,
      variants: state.variants > 1 ? state.variants : undefined,
      images: state.taskImages.length
        ? state.taskImages.map((i) => ({ mediaType: i.mediaType, data: i.data }))
        : undefined,
    };
    if (!body.task) return;
    if (state.taskSource === 'skill' && state.taskRef) {
      // A skill runs as a one-step inline chain — same shape the inbox and
      // the bookmarklet auto-start use (spec 008's API).
      body.steps = [{ id: 'task', name: state.taskRef, skill: state.taskRef, prompt: '{{task}}' }];
    } else {
      body.workflow = state.taskRef ?? 'quick-task';
    }
    discardPlan(); // a plain Run supersedes any pending plan (spec 008)
    $('#run-btn').disabled = true;
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      form.task.value = '';
      state.taskImages = [];
      renderTaskThumbs();
      form.task.dispatchEvent(new Event('blur')); // shrink the box back
      saveLastTaskSource();
      handleStarted(data);
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      $('#run-btn').disabled = false;
    }
  });

  bindPlanPanel();

  // Parallel variants (spec 010) have no form control right now — the ×1/×2/×3
  // switch was retired from the UI. The backend path stays: state.variants is
  // still sent with POST /api/runs whenever something sets it above 1.

  $('#run-list').addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // links navigate, not select
    const compare = e.target.closest('button[data-compare]');
    if (compare) {
      void selectGroup(compare.dataset.compare);
      return;
    }
    const item = e.target.closest('.run-item');
    if (!item) return;
    if (item.dataset.id) {
      showRunsView();
      selectRun(item.dataset.id);
    } else if (item.dataset.group) {
      // Group tile: toggle the variant list under it (in-memory UI state).
      const gid = item.dataset.group;
      if (state.expandedGroups.has(gid)) state.expandedGroups.delete(gid);
      else state.expandedGroups.add(gid);
      renderRunList();
    }
  });

  $('#list-tabs').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-list]');
    if (!btn) return;
    if (btn.dataset.list === 'archive-finished') {
      await fetch('/api/runs/archive-finished', { method: 'POST' });
      return; // SSE run updates re-render the list
    }
    state.listView = btn.dataset.list;
    renderRunList();
  });

  $('#detail').addEventListener('click', async (e) => {
    // Agent screenshots zoom into a lightbox.
    const shot = e.target.closest('[data-lightbox]');
    if (shot) {
      openLightbox(shot.dataset.lightbox, shot.dataset.name);
      return;
    }
    // Compare view (spec 010): "Pick this one" lives in #detail without a
    // selected run — handle it before the per-run actions.
    const pick = e.target.closest('button[data-pick]');
    if (pick) {
      void pickVariant(pick);
      return;
    }
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = state.selectedId;
    if (!id) return;
    if (btn.dataset.action === 'cancel') {
      await fetch(`/api/runs/${id}/cancel`, { method: 'POST' });
    } else if (btn.dataset.action === 'delete') {
      if (!confirm('Delete this run and its log?')) return;
      await fetch(`/api/runs/${id}`, { method: 'DELETE' });
    } else if (btn.dataset.action === 'finish') {
      await fetch(`/api/runs/${id}/finish`, { method: 'POST' });
    } else if (btn.dataset.action === 'archive') {
      const run = state.runs.get(id);
      await fetch(`/api/runs/${id}/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: !run?.archived }),
      });
    } else if (btn.dataset.action === 'continue') {
      const res = await fetch(`/api/runs/${id}/continue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alertBar(data.error ?? 'cannot continue');
      }
    } else if (btn.dataset.action === 'open-cli') {
      const res = await fetch(`/api/runs/${id}/open-in-cli`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.command) {
          try {
            await navigator.clipboard.writeText(data.command);
            alertBar('No terminal found — command copied to clipboard.');
          } catch {
            alertBar(`Run manually: ${data.command}`);
          }
        } else {
          alertBar(data.error ?? 'cannot open terminal');
        }
      }
    } else if (btn.dataset.action === 'diff') {
      const panel = $('#diff-panel');
      if (!panel) return;
      if (!panel.hidden) {
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      $('#diff-body').innerHTML = '<div class="dim">Loading…</div>';
      try {
        const res = await fetch(`/api/runs/${id}/diff`);
        const text = await res.text();
        $('#diff-body').innerHTML = text.trim() ? renderDiff(text) : '<div class="dim">(no changes yet)</div>';
      } catch (err) {
        $('#diff-body').textContent = `✗ ${err.message}`;
      }
    } else if (btn.dataset.action === 'send-back') {
      // Review gate (spec 009): the notes go back into the same session via
      // "Continue" — the run leaves `review`, works, and gates again.
      const notes = $('#review-notes')?.value.trim();
      if (!notes) {
        alertBar('Write what to change first.');
        $('#review-notes')?.focus();
        return;
      }
      btn.disabled = true;
      const res = await fetch(`/api/runs/${id}/continue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `Review feedback:\n${notes}` }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alertBar(data.error ?? 'cannot send back');
        btn.disabled = false;
      }
      // on success the SSE run update flips the status and hides the panel
    } else if (btn.dataset.action === 'draft-pr') {
      btn.disabled = true;
      const res = await fetch(`/api/runs/${id}/pr`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        alertBar(`Draft PR created — ${data.url}`);
      } else {
        alertBar(data.error ?? 'PR creation failed');
        const manual = $('#review-manual');
        if (manual && data.manual) {
          manual.hidden = false;
          manual.textContent = `manual path: ${data.manual}`;
        }
        btn.disabled = false;
      }
    } else if (btn.dataset.action === 'notes') {
      const panel = $('#notes-panel');
      if (!panel) return;
      if (!panel.hidden) {
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      $('#notes-md').textContent = 'Loading…';
      try {
        const res = await fetch(`/api/runs/${id}/handoff`);
        const text = await res.text();
        $('#notes-md').innerHTML = text.trim()
          ? renderMarkdown(text)
          : '<p class="dim">(no notes yet — the handoff file is seeded when the task starts)</p>';
      } catch (err) {
        $('#notes-md').textContent = `✗ ${err.message}`;
      }
    } else if (btn.dataset.action === 'remove-worktree') {
      const res = await fetch(`/api/runs/${id}/remove-worktree`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alertBar(data.error ?? 'cannot remove worktree');
      } else {
        alertBar('Worktree removed.');
      }
    } else if (btn.dataset.action === 'jump-bottom') {
      state.autoScroll = true;
      const log = $('#log');
      if (log) log.scrollTop = log.scrollHeight;
      btn.hidden = true;
    }
  });

  // Quick replies for agent questions (janitor-style): Alt+A approve, Alt+C continue.
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || !state.selectedId) return;
    if (e.code === 'KeyA') void sendMessage(state.selectedId, 'Yes, approved.', []);
    if (e.code === 'KeyC') void sendMessage(state.selectedId, 'Continue.', []);
  });
}

// ---- chain-from-prompt (spec 008) --------------------------------------------

function bindPlanPanel() {
  $('#plan-btn').addEventListener('click', () => void planTask());

  const panel = $('#plan-panel');
  panel.addEventListener('click', (e) => {
    if (!state.plan) return;
    const rm = e.target.closest('[data-plan-remove]');
    if (rm) {
      state.plan.steps.splice(Number(rm.dataset.planRemove), 1);
      renderPlan();
      return;
    }
    const btn = e.target.closest('button[data-plan-action]');
    if (!btn) return;
    if (btn.dataset.planAction === 'discard') discardPlan();
    else if (btn.dataset.planAction === 'start') void startPlannedRun(btn);
    else if (btn.dataset.planAction === 'save') void savePlanAsChain(btn);
  });

  // Reorder by drag (HTML5 draggable — no libraries).
  panel.addEventListener('dragstart', (e) => {
    const step = e.target.closest('.plan-step');
    if (!step) return;
    state.planDragIdx = Number(step.dataset.idx);
    e.dataTransfer.effectAllowed = 'move';
  });
  panel.addEventListener('dragover', (e) => {
    const step = e.target.closest('.plan-step');
    if (!step || state.planDragIdx === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    step.classList.add('drag-over');
  });
  panel.addEventListener('dragleave', (e) => {
    e.target.closest('.plan-step')?.classList.remove('drag-over');
  });
  panel.addEventListener('drop', (e) => {
    const step = e.target.closest('.plan-step');
    if (!step || state.planDragIdx === null || !state.plan) return;
    e.preventDefault();
    const from = state.planDragIdx;
    const to = Number(step.dataset.idx);
    state.planDragIdx = null;
    if (from === to) return;
    const [moved] = state.plan.steps.splice(from, 1);
    state.plan.steps.splice(to, 0, moved);
    renderPlan();
  });
  panel.addEventListener('dragend', () => {
    state.planDragIdx = null;
    for (const el of panel.querySelectorAll('.drag-over')) el.classList.remove('drag-over');
  });
}

async function planTask() {
  const form = $('#new-task');
  const task = form.task.value.trim();
  const errorBox = $('#form-error');
  errorBox.hidden = true;
  if (!task) {
    form.task.focus();
    return;
  }
  const btn = $('#plan-btn');
  const original = btn.innerHTML; // keep the star icon — no emoji swap
  btn.disabled = true;
  btn.classList.add('busy');
  btn.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l2 5.5L19.5 10 14 12l-2 5.5L10 12l-5.5-2L10 8.5 12 3z"/></svg>Planning…';
  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    state.plan = { task, steps: data.steps, rationale: data.rationale, fallback: data.fallback };
    renderPlan();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.innerHTML = original;
  }
}

function oneLine(s, max = 70) {
  const first = String(s ?? '').split('\n')[0] ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/* The proposed chain renders as an overlay over the main window (feedback
   2026-07-11: the sidebar was too cramped — step names and prompts were
   truncated to uselessness). Same bindings as before: #plan-panel, .plan-step,
   data-plan-* — only the placement and roominess changed. */
function renderPlan() {
  const overlay = $('#plan-overlay');
  const panel = $('#plan-panel');
  if (!state.plan) {
    overlay.hidden = true;
    panel.innerHTML = '';
    return;
  }
  const { task, steps, rationale, fallback } = state.plan;
  overlay.hidden = false;
  panel.innerHTML = `
    <div class="plan-head">
      <div style="min-width:0">
        <div class="panel-label" style="margin-bottom:5px">Proposed chain</div>
        <div class="plan-task" title="${esc(task)}">${esc(oneLine(task, 120))}</div>
      </div>
      <button type="button" class="plan-close" data-plan-action="discard" title="Discard the plan">×</button>
    </div>
    ${fallback ? '<div class="plan-note">planner unavailable — single-step plan</div>' : ''}
    ${rationale ? `<div class="plan-rationale">${esc(rationale)}</div>` : ''}
    <div class="plan-steps">
      ${steps
        .map(
          (s, i) => `
        <div class="plan-step" draggable="true" data-idx="${i}">
          <span class="grip" title="Drag to reorder">≡</span>
          <span class="num">${String(i + 1).padStart(2, '0')}</span>
          <div class="plan-step-main">
            <div class="row1">
              <span class="name">${esc(s.name ?? s.id)}</span>
              ${s.skill ? `<span class="plan-badge skill" title="skill">${esc(s.skill)}</span>` : ''}
              ${s.command ? '<span class="plan-badge check">check</span>' : ''}
            </div>
            <div class="hint">${esc(s.command ?? s.prompt ?? '')}</div>
          </div>
          <button type="button" class="plan-remove" data-plan-remove="${i}" title="Remove step">✕</button>
        </div>`,
        )
        .join('') || '<div class="dim">(no steps left — discard and plan again)</div>'}
    </div>
    <div class="plan-actions">
      <button type="button" class="btn-dark" data-plan-action="start" ${steps.length ? '' : 'disabled'}>▶ Start</button>
      <button type="button" class="btn-ghost" data-plan-action="save" ${steps.length ? '' : 'disabled'}>Save as chain</button>
      <button type="button" class="btn-ghost" data-plan-action="discard">Discard</button>
    </div>`;
}

function discardPlan() {
  state.plan = null;
  state.planDragIdx = null;
  renderPlan();
}

async function startPlannedRun(btn) {
  const form = $('#new-task');
  const task = form.task.value.trim() || state.plan.task;
  btn.disabled = true;
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task,
        steps: state.plan.steps,
        model: state.taskModel || undefined,
        variants: state.variants > 1 ? state.variants : undefined,
        images: state.taskImages.length
          ? state.taskImages.map((i) => ({ mediaType: i.mediaType, data: i.data }))
          : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    form.task.value = '';
    state.taskImages = [];
    renderTaskThumbs();
    discardPlan();
    handleStarted(data);
  } catch (err) {
    alertBar(err.message);
    btn.disabled = false;
  }
}

async function savePlanAsChain(btn) {
  const name = prompt('Chain name:');
  if (!name || !name.trim()) return;
  btn.disabled = true;
  try {
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), steps: state.plan.steps }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    alertBar(`Saved — ${String(data.path).split('/').pop()}`);
    const workflowsRes = await getJson('/api/workflows');
    setWorkflowOptions(workflowsRes.workflows);
  } catch (err) {
    alertBar(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---- live-session message bar ------------------------------------------------

function bindMessageBar(runId) {
  const form = $('#msg-form');
  const textarea = $('#msg-text');
  const fileInput = $('#msg-file');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    const images = state.pendingImages.map((i) => ({ mediaType: i.mediaType, data: i.data }));
    if (!text && images.length === 0) return;
    const ok = await sendMessage(runId, text, images);
    if (ok) {
      textarea.value = '';
      state.pendingImages = [];
      renderThumbs();
    }
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  textarea.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items ?? [])].filter((i) => i.type.startsWith('image/'));
    if (!items.length) return;
    e.preventDefault();
    for (const item of items) {
      const file = item.getAsFile();
      if (file) void addImage(file);
    }
  });

  $('#msg-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    for (const file of fileInput.files ?? []) void addImage(file);
    fileInput.value = '';
  });

  $('#msg-thumbs').addEventListener('click', (e) => {
    const thumb = e.target.closest('[data-idx]');
    if (!thumb) return;
    state.pendingImages.splice(Number(thumb.dataset.idx), 1);
    renderThumbs();
  });
}

/* File → {mediaType, data, preview}, or null when oversized. Shared by the
   live-session bar and the new-task form. */
async function readImageFile(file) {
  if (file.size > 5 * 1024 * 1024) {
    alertBar('Image too large (max 5 MB)');
    return null;
  }
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const data = btoa(binary);
  return { mediaType: file.type, data, preview: `data:${file.type};base64,${data}` };
}

async function addImage(file) {
  if (state.pendingImages.length >= 4) return;
  const img = await readImageFile(file);
  if (!img) return;
  state.pendingImages.push(img);
  renderThumbs();
}

function renderTaskThumbs() {
  const box = $('#task-thumbs');
  if (!box) return;
  box.hidden = state.taskImages.length === 0;
  box.innerHTML = state.taskImages
    .map((img, idx) => `<span class="thumb" data-idx="${idx}" title="Click to remove"><img src="${img.preview}"></span>`)
    .join('');
}

function renderThumbs() {
  const box = $('#msg-thumbs');
  if (!box) return;
  box.hidden = state.pendingImages.length === 0;
  box.innerHTML = state.pendingImages
    .map((img, idx) => `<span class="thumb" data-idx="${idx}" title="Click to remove"><img src="${img.preview}"></span>`)
    .join('');
}

async function sendMessage(runId, text, images) {
  try {
    const res = await fetch(`/api/runs/${runId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, images }),
    });
    if (res.status === 409) {
      alertBar('Session closed — the agent is no longer listening.');
      return false;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alertBar(data.error ?? `HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    alertBar(err.message);
    return false;
  }
}

function openLightbox(url, name) {
  closeLightbox();
  const el = document.createElement('div');
  el.id = 'lightbox';
  el.innerHTML = `
    <div class="lb-inner">
      <img src="${esc(url)}" alt="${esc(name ?? '')}">
      <div class="lb-name">${esc(name ?? '')} — click anywhere to close</div>
    </div>`;
  el.addEventListener('click', closeLightbox);
  document.body.appendChild(el);
}

function closeLightbox() {
  $('#lightbox')?.remove();
}

function alertBar(message) {
  const existing = $('#toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---- run list --------------------------------------------------------------

/* POST /api/runs answers with one run (×1) or {runs: [...]} (variants). */
function handleStarted(data) {
  const runs = Array.isArray(data.runs) ? data.runs : [data];
  for (const run of runs) state.runs.set(run.id, run);
  const first = runs[0];
  if (first?.groupId) state.expandedGroups.add(first.groupId);
  renderRunList();
  if (first) selectRun(first.id);
}

function sortedRuns() {
  // Needs-you-first: waiting/review, then running/queued, then by recency.
  return [...state.runs.values()]
    .filter((r) => (state.listView === 'archived' ? r.archived : !r.archived))
    .sort((a, b) => {
      const pa = STATUS_ORDER[a.status] ?? 9;
      const pb = STATUS_ORDER[b.status] ?? 9;
      if (pa !== pb) return pa - pb;
      return b.createdAt.localeCompare(a.createdAt);
    });
}

/* Which sidebar group a run (or a variant group's best member) belongs to. */
function bucketOf(status) {
  if (state.listView === 'archived') return 'Archived';
  if (status === 'waiting' || status === 'review') return 'Needs you';
  if (status === 'running' || status === 'queued') return 'Working';
  return 'Recent';
}

function renderRunList() {
  const all = [...state.runs.values()];
  const activeCount = all.filter((r) => !r.archived).length;
  const archivedCount = all.length - activeCount;
  const finishedCount = all.filter(
    (r) => !r.archived && ['done', 'failed', 'cancelled'].includes(r.status),
  ).length;
  const waitingCount = all.filter(
    (r) => !r.archived && (r.status === 'waiting' || r.status === 'review'),
  ).length;

  $('#list-tabs').innerHTML = `
    <button data-list="active" class="${state.listView === 'active' ? 'active' : ''}">
      Active${activeCount ? ` ${activeCount}` : ''}${waitingCount ? ' <span class="dot"></span>' : ''}
    </button>
    <button data-list="archived" class="${state.listView === 'archived' ? 'active' : ''}">
      Archived${archivedCount ? ` ${archivedCount}` : ''}
    </button>
    ${state.listView === 'active' && finishedCount ? `<button data-list="archive-finished" title="Archive all finished runs"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px;margin-right:4px"><path d="M4 5h16v4H4zM6 9v10h12V9M9 13h6"/></svg>${finishedCount}</button>` : ''}`;

  // Variant groups (spec 010): runs sharing a groupId collapse into one
  // group tile at the position of their best-ranked member; click expands.
  const runs = sortedRuns();
  const seenGroups = new Set();
  const buckets = new Map(); // label -> html[]
  const push = (label, html) => {
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(html);
  };
  for (const r of runs) {
    if (r.groupId) {
      if (seenGroups.has(r.groupId)) continue;
      seenGroups.add(r.groupId);
      const members = runs
        .filter((m) => m.groupId === r.groupId)
        .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''));
      if (members.length > 1) {
        push(bucketOf(r.status), groupTileHtml(r.groupId, members));
        continue;
      }
      // A lone survivor (the picked winner) renders like any other run.
    }
    push(bucketOf(r.status), runItemHtml(r));
  }
  const order = ['Needs you', 'Working', 'Recent', 'Archived'];
  $('#run-list').innerHTML =
    order
      .filter((label) => buckets.has(label))
      .map((label) => `<div class="group-label">${label}</div>${buckets.get(label).join('')}`)
      .join('') ||
    `<div class="dim" style="padding:14px 12px;font-size:12px">${
      state.listView === 'archived' ? 'Nothing archived yet.' : 'No runs yet — describe a task above.'
    }</div>`;
}

function runItemHtml(r, variantRow = false) {
  const timeText =
    r.status === 'queued' ? `#${queuePosition(r) ?? '·'}` : shortAgo(r.finishedAt ?? r.createdAt);
  return `
      <div class="run-item ${variantRow ? 'variant-row' : ''} ${r.id === state.selectedId ? 'selected' : ''}" data-id="${r.id}" title="${esc(r.task)}">
        <span class="dot ${esc(r.status)}"></span>
        ${r.variant ? `<span class="time">${esc(r.variant)}</span>` : ''}
        <span class="title">${esc(variantRow ? groupTitle(r) : r.title)}</span>
        ${r.pullRequestUrl ? `<a class="time" href="${esc(r.pullRequestUrl)}" target="_blank" rel="noopener" title="open the PR">PR↗</a>` : ''}
        <span class="time">${esc(timeText)}</span>
      </div>`;
}

function groupTileHtml(groupId, members) {
  const first = members[0];
  const expanded = state.expandedGroups.has(groupId);
  const allTerminal = members.every((m) => TERMINAL_STATUSES.includes(m.status));
  return `
      <div class="run-item group-item ${state.selectedGroupId === groupId ? 'selected' : ''}" data-group="${esc(groupId)}" title="${esc(first.task)}">
        <span class="time">${expanded ? '▾' : '▸'}</span>
        <span class="title">${esc(groupTitle(first))}</span>
        <span class="dots">${members
          .map((m) => `<span class="dot ${esc(m.status)}" title="${esc(`${m.variant ?? '?'} · ${m.status}`)}"></span>`)
          .join('')}</span>
        ${allTerminal ? `<button type="button" class="compare-btn" data-compare="${esc(groupId)}" title="Compare the variants' diffs side by side">⚖</button>` : `<span class="time">${members.length}×</span>`}
      </div>
      ${expanded ? members.map((m) => runItemHtml(m, true)).join('') : ''}`;
}

// ---- run detail ------------------------------------------------------------

function selectRun(id) {
  const run = state.runs.get(id);
  if (!run) return;
  state.selectedId = id;
  state.selectedGroupId = null;
  state.lastSeq = 0;
  state.autoScroll = true;
  if (state.runEs) {
    state.runEs.close();
    state.runEs = null;
  }
  renderRunList();
  renderDetailShell(run);

  const es = new EventSource(`/api/runs/${id}/events`);
  state.runEs = es;
  es.addEventListener('run-event', (e) => {
    const evt = JSON.parse(e.data);
    if (evt.seq <= state.lastSeq) return; // reconnect replay dedup
    state.lastSeq = evt.seq;
    appendLog(evt);
  });
  es.addEventListener('run', (e) => updateDetail(JSON.parse(e.data)));
}

function renderDetailShell(run) {
  state.pendingImages = [];
  $('#detail').innerHTML = `
    <div class="detail-head">
      <div class="meta-line" id="d-meta"></div>
      <div class="title-row">
        <h1 id="d-title"></h1>
        <span id="d-badge"></span>
      </div>
      <div class="head-bar">
        <span class="steps-line" id="d-steps"></span>
        <div class="spacer"></div>
        <span id="d-actions" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap"></span>
      </div>
      <div id="d-error" class="run-error" hidden></div>
      <div id="d-resume" class="resume-hint" hidden></div>
    </div>
    <div id="review-panel" class="detail-panel" hidden></div>
    <div id="diff-panel" class="detail-panel" hidden><div class="inner"><div class="panel-label">What this task changed</div><div id="diff-body"></div></div></div>
    <div id="notes-panel" class="detail-panel" hidden><div class="inner"><div class="panel-label">Handoff notes</div><div id="notes-md" class="md"></div></div></div>
    <div class="log-wrap">
      <div id="log"><div class="log-inner" id="log-inner"></div></div>
      <button id="jump-bottom" data-action="jump-bottom" hidden>↓ jump to bottom</button>
    </div>
    <div class="composer-wrap">
      <div id="waiting-note" hidden><span class="pulse-dot"></span>The agent is paused, waiting for your reply</div>
      <form id="msg-form">
        <div id="msg-thumbs" hidden></div>
        <div class="msg-row">
          <textarea id="msg-text" rows="1" placeholder="Message the agent…"></textarea>
          <button type="button" id="msg-attach" title="Attach an image (or paste a screenshot)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11l-8 8a5 5 0 01-7-7l8-8a3.4 3.4 0 015 5l-8 8a1.7 1.7 0 01-2.4-2.4l7-7"/></svg>
          </button>
          <button type="submit" id="msg-send" title="Send (Enter)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 19V5M6 11l6-6 6 6"/></svg>
          </button>
        </div>
        <input type="file" id="msg-file" accept="image/*" multiple hidden>
      </form>
    </div>`;
  bindMessageBar(run.id);
  updateDetail(run);
  $('#log').addEventListener('scroll', () => {
    const log = $('#log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    state.autoScroll = nearBottom;
    $('#jump-bottom').hidden = nearBottom;
  });
}

const STEP_MARK = { done: '✓', running: '●', waiting: '●', review: '●', failed: '✗' };

function updateDetail(run) {
  state.runs.set(run.id, run);
  const active = run.status === 'running' || run.status === 'queued' || run.status === 'waiting';
  const lastSession = [...run.steps].reverse().find((s) => s.sessionId)?.sessionId;
  const resumeCmd = run.worktreePath
    ? `cd ${run.worktreePath} && claude --resume ${lastSession}`
    : `claude --resume ${lastSession}`;

  const metaParts = [
    esc(run.workflow),
    esc(fmtTokens(run.tokensUsed)),
    run.costUsd ? esc(fmtCost(run.costUsd)) : null,
    `started ${esc(timeAgo(run.startedAt ?? run.createdAt))}`,
    run.finishedAt ? `finished ${esc(timeAgo(run.finishedAt))}` : null,
    run.model ? `model ${esc(run.model)}` : null,
    run.branch ? esc(run.branch) : null,
    prLink(run) || null,
  ].filter(Boolean);
  $('#d-meta').innerHTML = metaParts.map((p) => `<span>${p}</span>`).join('<span>·</span>');

  $('#d-title').textContent = run.title;
  $('#d-title').title = run.task;
  $('#d-badge').innerHTML = statusPill(run);

  $('#d-steps').innerHTML = run.steps
    .map((s) => {
      const mark = STEP_MARK[s.status] ?? '○';
      const label = `${mark} ${esc(s.name)}${s.iterations > 1 ? ` ×${s.iterations}` : ''}`;
      const tip = `${s.kind} · ${s.status} · ${fmtTokens(s.tokensUsed)}${s.error ? `\n${s.error}` : ''}${s.sessionId ? `\nsession: ${s.sessionId}` : ''}`;
      return `<span title="${esc(tip)}">${label}</span>`;
    })
    .join('<span style="opacity:.5">&nbsp;&nbsp;→&nbsp;&nbsp;</span>');

  $('#d-actions').innerHTML = `
    ${run.status === 'waiting' || run.status === 'review' ? `<button class="btn-dark" data-action="finish" title="${run.status === 'review' ? 'Accept the changes without a PR' : 'Close the session'}">${BI.check}Finish</button>` : ''}
    ${!active && lastSession ? `<button class="btn-text" data-action="continue">${BI.play}Continue</button><button class="btn-text" data-action="open-cli" title="Take over the session in a real terminal">${BI.terminal}Terminal</button>` : ''}
    ${run.worktreePath ? `<button class="btn-text" data-action="diff" title="What this task changed (worktree vs base)">${BI.diff}Diff</button>` : ''}
    <button class="btn-text" data-action="notes" title="Handoff notes — what the agent did and what's left">${BI.notes}Notes</button>
    ${run.archived && run.worktreePath ? `<button class="btn-text" data-action="remove-worktree" title="Remove the task worktree and its branch">${BI.folder}Remove worktree</button>` : ''}
    ${!active ? `<button class="btn-text" data-action="archive" title="${run.archived ? 'Unarchive' : 'Archive'}">${BI.archive}${run.archived ? 'Unarchive' : 'Archive'}</button>` : ''}
    ${active
      ? `<button class="btn-text danger" data-action="cancel">${BI.stop}Cancel</button>`
      : `<button class="btn-text danger" data-action="delete">${BI.trash}Delete</button>`}`;

  const errBox = $('#d-error');
  errBox.hidden = !run.error;
  if (run.error) errBox.textContent = `✗ ${run.error}`;
  const resumeBox = $('#d-resume');
  const showResume = !active && lastSession;
  resumeBox.hidden = !showResume;
  if (showResume) resumeBox.textContent = `take over interactively: ${resumeCmd}`;

  // Review gate (spec 009): the panel lives while the run rests at `review`;
  // it (re)loads the diff on each entry into review and clears on exit, so a
  // send-back round always comes back with a fresh diff.
  const reviewPanel = $('#review-panel');
  if (reviewPanel) {
    const inReview = run.status === 'review';
    reviewPanel.hidden = !inReview;
    if (inReview && !reviewPanel.dataset.loaded) {
      reviewPanel.dataset.loaded = '1';
      void renderReviewPanel(run.id);
    } else if (!inReview && reviewPanel.dataset.loaded) {
      delete reviewPanel.dataset.loaded;
      reviewPanel.innerHTML = '';
    }
  }

  const msgForm = $('#msg-form');
  if (msgForm) {
    const sessionOpen = run.status === 'running' || run.status === 'waiting';
    msgForm.classList.toggle('disabled', !sessionOpen);
    $('#msg-text').disabled = !sessionOpen;
    $('#msg-send').disabled = !sessionOpen;
    $('#msg-attach').disabled = !sessionOpen;
    $('#msg-text').placeholder = sessionOpen
      ? run.status === 'waiting'
        ? 'Reply to the agent… (Enter to send, ⌘V pastes a screenshot)'
        : 'Message the agent… (Enter to send, ⌘V pastes a screenshot)'
      : 'Session closed — Continue to reopen.';
    $('#waiting-note').hidden = run.status !== 'waiting';
  }
}

/* Review gate panel (spec 009): the full diff on top, then a notes field with
   exactly two buttons — "Send back" (feedback into the same session) and
   "Draft PR". The third exit, "✓ Finish" (accept without a PR), sits in the
   detail header. */
async function renderReviewPanel(runId) {
  const panel = $('#review-panel');
  if (!panel) return;
  // A PR the agent already opened itself (skill-driven `gh pr create`, spotted
  // in the transcript) replaces the Draft PR button — a second click would
  // open a duplicate PR.
  const prUrl = state.runs.get(runId)?.pullRequestUrl;
  panel.innerHTML = `
    <div class="inner">
      <div class="panel-label">Changes ready for review</div>
      <div id="review-diff"><div class="dim">Loading diff…</div></div>
      <textarea id="review-notes" rows="2" placeholder="Notes for the agent — what should change?"></textarea>
      <div class="review-buttons">
        <button type="button" class="btn-ghost" data-action="send-back" title="Send the notes back into the agent's session">↩ Send back</button>
        ${
          prUrl
            ? `<a class="btn-dark" style="text-decoration:none" href="${esc(prUrl)}" target="_blank" rel="noopener" title="The agent already opened this PR">PR ↗ open on GitHub</a>`
            : '<button type="button" class="btn-dark" data-action="draft-pr" title="Push the branch and open a draft PR">Draft PR</button>'
        }
      </div>
      <div id="review-manual" class="dim mono" hidden></div>
    </div>`;
  try {
    const res = await fetch(`/api/runs/${runId}/diff`);
    const text = await res.text();
    const box = $('#review-diff');
    if (box) box.innerHTML = renderDiff(text);
  } catch (err) {
    const box = $('#review-diff');
    if (box) box.textContent = `✗ ${err.message}`;
  }
}

// ---- variant compare view (spec 010) ----------------------------------------

/* "⚖ Compare": columns per variant — status, cost, `git diff --stat`, the
   first Progress-log lines — each with a "Pick this one" button; full diffs
   collapse under the columns (renderDiff from spec 009, reused). */
async function selectGroup(groupId) {
  state.selectedGroupId = groupId;
  state.selectedId = null;
  if (state.runEs) {
    state.runEs.close();
    state.runEs = null;
  }
  showRunsView();
  renderRunList();
  const detail = $('#detail');
  detail.innerHTML = '<div class="empty">Loading variants…</div>';
  let data;
  try {
    data = await getJson(`/api/groups/${groupId}`);
  } catch (err) {
    detail.innerHTML = `<div class="empty">✗ ${esc(err.message)}</div>`;
    return;
  }
  if (state.selectedGroupId !== groupId) return; // user moved on meanwhile
  renderCompareView(data.runs);
}

function renderCompareView(variants) {
  const title = variants.length ? groupTitle(variants[0]) : '';
  $('#detail').innerHTML = `
    <div class="compare-view"><div class="inner">
      <div class="compare-head">
        <h1 title="${esc(title)}">⚖ ${esc(title)}</h1>
        <span class="dim">${variants.length} variants — pick the diff you want to keep; the others are archived and their worktrees removed</span>
      </div>
      <div class="compare-cols">
        ${variants
          .map(
            (v) => `
        <div class="compare-col">
          <div class="col-head"><span class="variant-letter">${esc(v.variant)}</span> ${statusPill(v)}</div>
          <div class="col-meta">${fmtTokens(v.tokensUsed)}${v.costUsd ? ` · ${fmtCost(v.costUsd)}` : ''}</div>
          <pre class="col-stat">${esc(v.diffStat || '(no changes)')}</pre>
          <pre class="col-handoff">${esc(v.handoffExcerpt || '(no progress notes)')}</pre>
          <button type="button" class="btn-dark" data-pick="${esc(v.id)}">✔ Pick this one</button>
        </div>`,
          )
          .join('')}
      </div>
      <div class="compare-diffs">
        ${variants
          .map(
            (v) => `
        <details class="compare-diff">
          <summary>Variant ${esc(v.variant)} — full diff</summary>
          <div class="diff-body" data-group-diff="${esc(v.id)}"><div class="dim">Loading…</div></div>
        </details>`,
          )
          .join('')}
      </div>
    </div></div>`;
  // Full diffs (max 3) via the existing per-run endpoint.
  for (const v of variants) {
    void fetch(`/api/runs/${v.id}/diff`)
      .then((r) => r.text())
      .then((text) => {
        const box = document.querySelector(`[data-group-diff="${v.id}"]`);
        if (box) box.innerHTML = renderDiff(text);
      })
      .catch(() => undefined);
  }
}

/* "Pick this one" → the winner rests at `review` (the spec-009 gate takes it
   from there); the losers are archived and their worktrees removed. */
async function pickVariant(btn) {
  const groupId = state.selectedGroupId;
  if (!groupId) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/groups/${groupId}/pick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: btn.dataset.pick }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (data.winner) state.runs.set(data.winner.id, data.winner);
    state.expandedGroups.delete(groupId);
    renderRunList();
    if (data.winner) selectRun(data.winner.id); // lands on the review gate
  } catch (err) {
    alertBar(err.message);
    btn.disabled = false;
  }
}

// ---- transcript ------------------------------------------------------------

/* The most telling single argument of a tool call — a command, a path, a
   pattern — shown inside the tool chip. */
/* Design language for tool chips: a human verb, not the raw tool name —
   "✓ Ran `npm test`", "✓ Accepted edits to `src/x.ts`". Unknown tools keep
   their name as the verb. */
const TOOL_VERB = {
  Bash: 'Ran',
  Read: 'Read',
  Edit: 'Accepted edits to',
  MultiEdit: 'Accepted edits to',
  NotebookEdit: 'Accepted edits to',
  Write: 'Created',
  Grep: 'Searched',
  Glob: 'Searched',
  LS: 'Listed',
  WebFetch: 'Fetched',
  WebSearch: 'Searched the web for',
  TodoWrite: 'Updated the todo list',
  Task: 'Delegated',
};

function toolVerb(tool) {
  return TOOL_VERB[tool] ?? tool;
}

function toolArg(input) {
  if (input == null) return null;
  if (typeof input === 'string') return input.trim() || null;
  if (typeof input !== 'object') return String(input);
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'name', 'description', 'prompt']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // No recognizable primary argument — the design never shows raw JSON blobs.
  return null;
}

function appendLog(evt) {
  const inner = $('#log-inner');
  const log = $('#log');
  if (!inner || !log) return;
  const el = document.createElement('div');

  switch (evt.type) {
    case 'text':
      // Agents speak markdown — render it (bold, code, lists) instead of
      // showing raw ** and ##.
      el.className = 'ev text md';
      el.innerHTML = renderMarkdown(evt.text ?? '');
      break;
    case 'tool-call': {
      el.className = 'ev tool';
      const arg = toolArg(evt.input);
      el.innerHTML = `<span class="ok">✓</span><span>${esc(toolVerb(evt.tool))}</span>${
        arg ? `<span class="arg">${esc(oneLine(arg, 64))}</span>` : ''
      }`;
      el.title = arg && arg.length > 64 ? arg.slice(0, 1000) : evt.tool;
      break;
    }
    case 'tool-result': {
      const result = String(evt.result ?? '');
      const first = (result.split('\n')[0] ?? '').slice(0, 140);
      const hasMore = result.length > first.length;
      el.className = `ev result${evt.isError ? ' error' : ''}`;
      el.innerHTML = hasMore
        ? `<details><summary><span class="lead-in">↳</span><span class="head">${esc(first)}${result.length > 140 ? '…' : ''}</span><span class="show">show</span></summary><pre>${esc(result.slice(0, 10_000))}</pre></details>`
        : `<span class="ev tool" style="margin:0"><span class="lead-in" style="color:var(--text3);font-size:11px">↳</span><span>${esc(first)}</span></span>`;
      break;
    }
    case 'check-output': {
      el.className = 'ev check';
      const ok = evt.exitCode === 0;
      el.innerHTML = `
        <div class="check-head">
          <span class="lbl">Command</span>
          <code>${esc(evt.command ?? evt.stepId ?? 'check')}</code>
          <span class="check-pill ${ok ? 'pass' : 'fail'}">${ok ? 'passed' : `failed (exit ${esc(String(evt.exitCode))})`}</span>
        </div>
        <pre>${esc(String(evt.text ?? ''))}</pre>`;
      break;
    }
    case 'image':
      el.className = 'ev image-ev';
      el.innerHTML = `
        <div class="img-card" data-lightbox="${esc(evt.url)}" data-name="${esc(evt.name)}" title="Click to zoom">
          <img src="${esc(evt.url)}" alt="${esc(evt.name)}" loading="lazy">
          <div class="img-foot">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5h16v14H4z"/><path d="M4 15l5-5 4 4 3-3 4 4"/><circle cx="9.5" cy="9.5" r="1.1"/></svg>
            <span class="nm">${esc(evt.name)}</span>
            <span class="zm">click to zoom</span>
          </div>
        </div>`;
      break;
    case 'step-start':
      el.className = 'ev step';
      el.innerHTML = `<span class="step-label">${esc(evt.name ?? evt.stepId ?? 'step')}${evt.iteration > 1 ? ` · attempt ${esc(String(evt.iteration))}` : ''}</span><div class="rule"></div>`;
      break;
    case 'step-end':
      // Successful step ends are already told by the steps rail and the next
      // step divider — the design keeps the transcript free of this noise.
      if (evt.status !== 'failed') return;
      el.className = 'ev note';
      el.textContent = `step ${evt.stepId}: failed${evt.error ? ` — ${evt.error}` : ''}`;
      break;
    case 'note':
    case 'lifecycle':
      el.className = 'ev note';
      el.textContent = `· ${evt.message ?? ''}`;
      break;
    case 'user-message': {
      el.className = 'ev user';
      const imgs = evt.imageCount > 0 ? ` [${evt.imageCount} image${evt.imageCount > 1 ? 's' : ''}]` : '';
      el.innerHTML = `<div class="bubble">${esc(`${evt.text ?? ''}${imgs}`)}</div>`;
      break;
    }
    case 'error':
      el.className = 'ev err';
      el.textContent = `✗ ${evt.message ?? ''}`;
      break;
    case 'token-usage':
    case 'cost':
    case 'turn-end':
      return; // reflected in the header/steps already
    case 'done':
      return;
    default:
      el.className = 'ev note';
      el.textContent = JSON.stringify(evt);
  }

  inner.appendChild(el);
  if (state.autoScroll) log.scrollTop = log.scrollHeight;
}

// ---- inbox view (spec 007) -----------------------------------------------------

/* Entries already turned into a task (startedTaskId) are hidden — they stay
   in todos.json as an audit trail. */
function visibleTodos() {
  return state.todos.filter((t) => !t.startedTaskId);
}

function renderInboxBadge() {
  const badgeEl = $('#inbox-badge');
  if (!badgeEl) return;
  const count = visibleTodos().length;
  badgeEl.textContent = count;
  badgeEl.hidden = count === 0;
}

function showRunsView() {
  const btn = $('#tabs button[data-view="runs"]');
  if (btn && !btn.classList.contains('active')) btn.click();
}

function renderInbox() {
  const view = $('#view-inbox');
  const todos = visibleTodos();
  view.innerHTML = `
    <div class="page">
      <h1>Inbox</h1>
      <p class="lead">Follow-ups agents suggested when they finished a task.</p>
      ${
        todos.length
          ? todos
              .map((t) => {
                const source = t.taskId
                  ? state.runs.has(t.taskId)
                    ? `<a href="#" data-goto-run="${esc(t.taskId)}">source task</a>`
                    : '<span class="gone">source task deleted</span>'
                  : '';
                const pr = t.prUrl
                  ? `<a href="${esc(t.prUrl)}" target="_blank" rel="noopener">PR</a>`
                  : '';
                return `
      <div class="todo-card" data-id="${esc(t.id)}">
        <div class="todo-main">
          <div class="summary">${esc(t.summary)}</div>
          <div class="meta">
            ${t.ts ? `<span>${esc(timeAgo(t.ts))}</span>` : ''}
            ${t.action ? `<span>${esc(t.action)}</span>` : ''}
            ${source} ${pr}
            ${t.suggestedSkill ? `<span>skill: ${esc(t.suggestedSkill)}</span>` : ''}
          </div>
        </div>
        <button class="btn-dark" data-todo-action="start" title="Start a task from this follow-up">▶ Run</button>
        <button class="btn-text" data-todo-action="remove" title="Check off (remove)">Dismiss</button>
      </div>`;
              })
              .join('')
          : '<div class="dim" style="padding:16px 0">Inbox empty — agents drop follow-up suggestions here when they finish a task.</div>'
      }
    </div>`;
}

// ---- GitHub view -------------------------------------------------------------

const GH_ISSUE_ICON = 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 10.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z';
const GH_PR_ICON =
  'M7 8.5v7M7 3.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM7 15.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM17 15.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM17 15v-4a3 3 0 00-3-3h-2.5';

function bindGithubView() {
  const view = $('#view-github');
  view.addEventListener('click', async (e) => {
    const refresh = e.target.closest('[data-gh-refresh]');
    if (refresh) {
      await loadGithub(true);
      return;
    }
    const tab = e.target.closest('button[data-gh-view]');
    if (tab) {
      state.ghView = tab.dataset.ghView;
      state.ghSel = null;
      renderGithub();
      return;
    }
    const row = e.target.closest('.gh-row');
    if (row) {
      state.ghSel = row.dataset.url;
      renderGithub();
      return;
    }
    const wf = e.target.closest('button[data-gh-workflow]');
    if (wf) {
      // Click the selected chip again to deselect — no workflow means the
      // run uses the toggled skills (or quick-task).
      state.ghWorkflow = state.ghWorkflow === wf.dataset.ghWorkflow ? null : wf.dataset.ghWorkflow;
      renderGithub();
      return;
    }
    const sk = e.target.closest('button[data-gh-skill]');
    if (sk) {
      const name = sk.dataset.ghSkill;
      if (state.ghSkills.has(name)) state.ghSkills.delete(name);
      else state.ghSkills.add(name);
      renderGithub();
      return;
    }
    const viewRun = e.target.closest('button[data-gh-view-run]');
    if (viewRun) {
      showRunsView();
      selectRun(viewRun.dataset.ghViewRun);
      return;
    }
    const runBtn = e.target.closest('button[data-gh-run]');
    if (runBtn) {
      await runOnGithub(runBtn);
      return;
    }
  });

  // Live filter over the skill chips — re-renders only the chip box so the
  // input keeps focus (and the page keeps its scroll).
  view.addEventListener('input', (e) => {
    if (e.target.id !== 'gh-skill-filter') return;
    state.ghSkillQuery = e.target.value;
    const box = $('#gh-skill-chips');
    if (box) box.innerHTML = ghSkillChipsHtml();
  });

  // Drag an issue/PR row into the task box — it prefills the same prompt
  // "Run agent on this issue" uses; skill/workflow you pick in the form.
  view.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.gh-row[data-url]');
    if (!row) return;
    const item = ghItems().find((i) => i.url === row.dataset.url);
    if (!item) return;
    try {
      e.dataTransfer.setData('text/plain', ghTaskPrompt(item));
      e.dataTransfer.effectAllowed = 'copy';
    } catch {
      // older engines — drag just won't carry the prompt
    }
  });
}

/* Two-shot load (feedback 2026-07-11 — the 30-item gh default hid the rest):
   the first fast fetch paints the tab, then a background "everything open"
   fetch (limit 1000) replaces it and fixes the counts. */
async function loadGithub(refresh = false) {
  const view = $('#view-github');
  if (!state.gh || refresh) {
    if (!state.gh) view.innerHTML = '<div class="gh-unavailable">Loading GitHub…</div>';
    try {
      // Skill chips ride along — same catalog as the Skills tab.
      const [gh, skills] = await Promise.all([
        getJson(`/api/github${refresh ? '?refresh=1' : ''}`),
        state.skillsList ? Promise.resolve(state.skillsList) : getJson('/api/skills').catch(() => []),
      ]);
      state.gh = gh;
      state.skillsList = skills;
      state.ghFull = false;
    } catch (err) {
      view.innerHTML = `<div class="gh-unavailable">✗ ${esc(err.message)}</div>`;
      return;
    }
  }
  renderGithub();
  if (state.gh?.available && !state.ghFull) void loadGithubFull();
}

async function loadGithubFull() {
  if (state.ghFullLoading) return;
  state.ghFullLoading = true;
  try {
    const full = await getJson('/api/github?limit=1000');
    if (full.available) {
      state.gh = full;
      state.ghFull = true;
      renderGithub();
    }
  } catch {
    // the fast batch stays — counts just keep their "+"
  } finally {
    state.ghFullLoading = false;
  }
}

function ghItems() {
  if (!state.gh) return [];
  return state.ghView === 'issues' ? state.gh.issues : state.gh.prs;
}

function renderGithub() {
  const view = $('#view-github');
  const gh = state.gh;
  if (!gh) return;
  if (!gh.available) {
    view.innerHTML = `
      <div class="gh-unavailable">
        <div style="font-family:var(--serif);font-size:21px;color:var(--text);margin-bottom:10px">GitHub</div>
        GitHub is unavailable here — ${esc(gh.reason ?? 'unknown reason')}.<br><br>
        The tab needs the <span class="mono">gh</span> CLI, logged in (<span class="mono">gh auth login</span>),
        and a repo with a GitHub remote. Everything else in cezar works without it.
        <div style="margin-top:14px"><button class="btn-ghost" data-gh-refresh>⟳ Try again</button></div>
      </div>`;
    return;
  }

  const items = ghItems();
  let sel = items.find((i) => i.url === state.ghSel) ?? items[0] ?? null;
  if (sel) state.ghSel = sel.url;

  const rows = items.length
    ? items
        .map((i) => {
          const queuedRun = state.ghQueued.get(i.url);
          return `
      <div class="gh-row ${sel && i.url === sel.url ? 'selected' : ''}" data-url="${esc(i.url)}" draggable="true" title="Drag into the task box to prefill a task">
        <div class="row1">
          <svg viewBox="0 0 24 24" style="stroke:${i.kind === 'issue' ? 'var(--green)' : 'var(--accent)'}"><path d="${i.kind === 'issue' ? GH_ISSUE_ICON : GH_PR_ICON}"/></svg>
          <span class="t">${esc(i.title)}</span>
        </div>
        <div class="row2">
          <span>#${i.number}</span><span>${esc(i.author)}</span><span>${esc(shortAgo(i.createdAt))}</span>
          ${queuedRun ? '<span class="queued-flag">↗ run queued</span>' : ''}
        </div>
      </div>`;
        })
        .join('')
    : `<div class="dim" style="padding:12px">No open ${state.ghView === 'issues' ? 'issues' : 'pull requests'}.</div>`;

  const detail = sel ? ghDetailHtml(sel) : '<div class="empty">Nothing selected.</div>';

  // A full re-render must not jump the scroll (feedback 2026-07-11: toggling
  // a skill chip yanked the detail back to the top).
  const rowsScroll = view.querySelector('.split-rows')?.scrollTop ?? 0;
  const detailScroll = view.querySelector('.split-detail')?.scrollTop ?? 0;

  // Until the background full fetch lands, a count at the fast-batch cap is
  // really "30 of who knows" — say so.
  const countLabel = (n) => `${n}${!state.ghFull && n >= 30 ? '+' : ''}`;

  view.innerHTML = `
    <div class="split">
      <div class="split-list">
        <div class="split-head">
          <div class="head-row">
            <h1>GitHub</h1>
            <span class="mono dim" style="font-size:10.5px">${esc(gh.repo ?? '')}</span>
            <button class="head-note" data-gh-refresh style="border:none;background:transparent;cursor:pointer" title="Refresh from GitHub">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11a8 8 0 10-2.3 5.7M20 11V5m0 6h-6"/></svg>
              synced ${esc(gh.syncedAt ? shortAgo(gh.syncedAt) : '?')} ago${state.ghFullLoading ? ' · loading all…' : ''}
            </button>
          </div>
          <div class="sub-tabs">
            <button data-gh-view="issues" class="${state.ghView === 'issues' ? 'active' : ''}">Issues · ${countLabel(gh.issues.length)}</button>
            <button data-gh-view="prs" class="${state.ghView === 'prs' ? 'active' : ''}">Pull requests · ${countLabel(gh.prs.length)}</button>
          </div>
        </div>
        <div class="split-rows">${rows}</div>
      </div>
      <div class="split-detail">${detail}</div>
    </div>`;

  const rowsEl = view.querySelector('.split-rows');
  if (rowsEl) rowsEl.scrollTop = rowsScroll;
  const detailEl = view.querySelector('.split-detail');
  if (detailEl) detailEl.scrollTop = detailScroll;
}

function ghDetailHtml(item) {
  const kindWord = item.kind === 'pr' ? 'pull request' : 'issue';
  const diffStat =
    item.kind === 'pr' && (item.additions || item.deletions) ? ` · +${item.additions} −${item.deletions}` : '';
  const checks = item.checks
    ? `<span class="gh-checks ${esc(item.checks)}">${
        item.checks === 'passing' ? '✓ checks passing' : item.checks === 'failing' ? '✗ checks failing' : '○ checks pending'
      }</span>`
    : '';
  const skills = (state.skillsList ?? []).map((s) => s.name);
  const queuedRun = state.ghQueued.get(item.url);
  return `
    <div class="inner">
      <div class="mono dim" style="font-size:10.5px">#${item.number} · ${kindWord} · opened by ${esc(item.author)} · ${esc(shortAgo(item.createdAt))} ago${item.comments ? ` · ${item.comments} comments` : ''}${diffStat} · <a href="${esc(item.url)}" target="_blank" rel="noopener">open on GitHub ↗</a></div>
      <h1 style="margin-top:8px">${esc(item.title)}</h1>
      <div style="display:flex;align-items:center;gap:7px;margin-top:12px;flex-wrap:wrap">
        ${item.labels.map((l) => `<span class="gh-label">${esc(l)}</span>`).join('')}
        ${checks}
      </div>
      <div class="gh-body md">${item.body ? renderMarkdown(item.body) : '<p class="dim">(no description)</p>'}</div>
      <div class="gh-hand">
        <div class="hand-label">
          <svg viewBox="0 0 24 24"><path d="M13 2L4.5 13.5h5.5L9 22l8.5-11.5H12L13 2z"/></svg>
          Hand this to the agent
        </div>
        <div class="hand-row">
          <span class="k" style="padding-top:0;align-self:center">workflow</span>
          <div class="chips">
            ${state.workflows
              .map(
                (w) =>
                  `<button class="chip-toggle ${state.ghWorkflow === w.name ? 'on' : ''}" data-gh-workflow="${esc(w.name)}" title="${esc(w.description ?? '')}${state.ghWorkflow === w.name ? ' — click again to deselect' : ''}">${esc(w.name)}</button>`,
              )
              .join('')}
          </div>
        </div>
        ${
          skills.length
            ? `<div class="hand-row">
          <span class="k">skills</span>
          <div style="flex:1;min-width:0">
            ${
              skills.length > 10
                ? `<input id="gh-skill-filter" class="filter-input" style="width:min(260px,100%);margin:0 0 8px" placeholder="Filter skills…" value="${esc(state.ghSkillQuery)}">`
                : ''
            }
            <div class="chips" id="gh-skill-chips">${ghSkillChipsHtml()}</div>
          </div>
        </div>`
            : ''
        }
        <div class="go-row">
          <button class="btn-dark" data-gh-run="${esc(item.url)}">▶ Run agent on this ${item.kind === 'pr' ? 'PR' : 'issue'}</button>
          ${
            queuedRun
              ? `<span class="queued-ok">✓ queued</span><button class="btn-text" data-gh-view-run="${esc(queuedRun)}">View in Runs →</button>`
              : ''
          }
        </div>
      </div>
    </div>`;
}

/* Skill chips, filterable — toggled-on chips always stay visible so the
   filter can't hide your selection. */
function ghSkillChipsHtml() {
  const q = state.ghSkillQuery.trim().toLowerCase();
  const names = (state.skillsList ?? []).map((s) => s.name);
  const shown = names.filter((n) => state.ghSkills.has(n) || !q || n.toLowerCase().includes(q));
  if (!shown.length) return '<span class="dim" style="font-size:11.5px">No skills match.</span>';
  return shown
    .map(
      (name) =>
        `<button class="chip-toggle ${state.ghSkills.has(name) ? 'on' : ''}" data-gh-skill="${esc(name)}">${esc(name)}</button>`,
    )
    .join('');
}

/* The prompt handed to the agent — shared by "Run agent on this …" and the
   drag-into-the-task-box path. */
function ghTaskPrompt(item, skillNames = []) {
  let task = `${item.kind === 'pr' ? 'Address GitHub pull request' : 'Fix GitHub issue'} #${item.number}: ${item.title}\n\n${item.url}`;
  if (item.body?.trim()) task += `\n\n---\n\n${item.body.trim()}`;
  if (skillNames.length) task += `\n\nUse these skills where relevant: ${skillNames.join(', ')}.`;
  return task;
}

async function runOnGithub(btn) {
  const item = ghItems().find((i) => i.url === btn.dataset.ghRun);
  if (!item) return;
  const skills = [...state.ghSkills].filter((name) => (state.skillsList ?? []).some((s) => s.name === name));
  // Workflow chip set → that workflow (skills ride along as a prompt hint).
  // No workflow but skills toggled → the skills ARE the chain (spec 008).
  // Nothing selected → quick-task.
  let body;
  if (state.ghWorkflow) {
    body = { workflow: state.ghWorkflow, task: ghTaskPrompt(item, skills) };
  } else if (skills.length) {
    const steps = [];
    for (const name of skills.slice(0, 8)) steps.push(wbSkillStep(name, steps));
    body = { steps, task: ghTaskPrompt(item) };
  } else {
    body = { workflow: 'quick-task', task: ghTaskPrompt(item) };
  }
  btn.disabled = true;
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    state.runs.set(data.id, data);
    state.ghQueued.set(item.url, data.id);
    state.lastGhRun = data.id;
    renderRunList();
    renderGithub();
  } catch (err) {
    alertBar(err.message);
    btn.disabled = false;
  }
}

// ---- repo view ---------------------------------------------------------------

function statusClass(status) {
  if (/A|\?/.test(status)) return 'added';
  if (/D/.test(status)) return 'deleted';
  return '';
}

async function loadRepo() {
  const view = $('#view-repo');
  view.innerHTML = '<div class="page dim">Loading…</div>';
  try {
    const [repo, diff] = await Promise.all([
      getJson('/api/repo'),
      fetch('/api/repo/diff').then((r) => r.text()),
    ]);
    if (!repo.info) {
      view.innerHTML = '<div class="page"><h1>Repository</h1><p class="lead">Not a git repository — tasks run in place, one at a time.</p></div>';
      return;
    }
    view.innerHTML = `
      <div class="page">
        <h1>Repository</h1>
        <p class="lead mono" style="font-size:12px">${esc(repo.info.root)} · ${esc(repo.info.branch)}${repo.info.remote ? ` · ${esc(repo.info.remote)}` : ''}</p>

        <div class="section-label">Agent base branch</div>
        <div class="base-branch-row">
          <select id="base-branch">
            <option value="" ${repo.baseBranch ? '' : 'selected'}>current checkout (${esc(repo.info.branch)})</option>
            ${(repo.branches ?? [])
              .map((b) => `<option value="${esc(b)}" ${repo.baseBranch === b ? 'selected' : ''}>${esc(b)}</option>`)
              .join('')}
          </select>
          <span class="dim" style="font-size:11.5px;line-height:1.5">Task worktrees fork from this branch and draft PRs target it. Saved to <span class="mono">.ai/cezar/config.json</span>.</span>
        </div>

        <div class="section-label">Working tree · ${repo.status.length ? `${repo.status.length} changed` : 'clean'}</div>
        ${
          repo.status.length
            ? repo.status
                .map(
                  (s) =>
                    `<div class="repo-file"><span class="st ${statusClass(s.status)}">${esc(s.status)}</span><span class="p">${esc(s.path)}</span></div>`,
                )
                .join('')
            : '<div class="dim" style="font-size:12.5px">Nothing modified.</div>'
        }
        ${
          diff.trim()
            ? `<details class="repo-diff"><summary>Diff vs HEAD</summary><div class="diff-wrap">${renderDiff(diff)}</div></details>`
            : ''
        }

        <div class="section-label">Recent commits</div>
        ${repo.log
          .map(
            (l) => `
              <div class="commit-row clickable" data-sha="${esc(l.hash)}" title="Show this commit">
                <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
                <span class="hash">${esc(l.hash)}</span><span class="subj">${esc(l.subject)}</span><span class="when" title="${esc(l.author)}">${esc(l.when)}</span>
              </div>
              <div class="commit-diff" data-diff-for="${esc(l.hash)}" hidden></div>`,
          )
          .join('')}
      </div>`;
    view.dataset.ghBase = githubBaseUrl(repo.info.remote) ?? '';
  } catch (err) {
    view.innerHTML = `<div class="page">✗ ${esc(err.message)}</div>`;
  }
}

/* `git@github.com:o/r.git` / `https://github.com/o/r(.git)` → https://github.com/o/r */
function githubBaseUrl(remote) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remote ?? '');
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/* Click a commit row → expand its message + patch inline (spec: Repo view).
   Bound once; loadRepo re-renders the innerHTML under it. */
function bindRepoView() {
  const view = $('#view-repo');

  // Base-branch picker → PUT /api/config (empty value clears back to "current").
  view.addEventListener('change', async (e) => {
    if (e.target.id !== 'base-branch') return;
    const value = e.target.value || null;
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseBranch: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      alertBar(value ? `New tasks will branch off "${value}" (PRs target it too).` : 'Base branch cleared — tasks follow the current checkout.');
    } catch (err) {
      alertBar(err.message);
    }
  });

  view.addEventListener('click', async (e) => {
    if (e.target.closest('a')) return; // the GitHub link inside an expanded diff
    const row = e.target.closest('.commit-row[data-sha]');
    if (!row) return;
    const sha = row.dataset.sha;
    const box = view.querySelector(`.commit-diff[data-diff-for="${CSS.escape(sha)}"]`);
    if (!box) return;
    if (!box.hidden) {
      box.hidden = true;
      row.classList.remove('open');
      return;
    }
    row.classList.add('open');
    box.hidden = false;
    if (!box.dataset.loaded) {
      box.innerHTML = '<div class="dim" style="padding:8px 2px;font-size:12px">Loading…</div>';
      try {
        const text = await fetch(`/api/repo/commit/${encodeURIComponent(sha)}`).then((r) => r.text());
        // `git show` = message + stat, then the patch — split so renderDiff
        // doesn't swallow the preamble.
        const at = text.indexOf('\ndiff --git ');
        const head = at === -1 ? text : text.slice(0, at);
        const patch = at === -1 ? '' : text.slice(at + 1);
        const ghBase = view.dataset.ghBase;
        box.innerHTML = `
          ${ghBase ? `<a class="commit-gh" href="${esc(ghBase)}/commit/${esc(sha)}" target="_blank" rel="noopener">View on GitHub ↗</a>` : ''}
          <pre class="commit-head">${esc(head.trim())}</pre>
          ${patch ? `<div class="diff-wrap">${renderDiff(patch)}</div>` : ''}`;
        box.dataset.loaded = '1';
      } catch (err) {
        box.innerHTML = `<div class="error-text">✗ ${esc(err.message)}</div>`;
      }
    }
  });
}

// ---- skills view ---------------------------------------------------------------

const SKILL_ICON = 'M12 3l2 5.5L19.5 10 14 12l-2 5.5L10 12l-5.5-2L10 8.5 12 3z';

function bindSkillsView() {
  const view = $('#view-skills');
  view.addEventListener('click', (e) => {
    if (e.target.closest('#skills-refresh')) {
      void loadSkills(true);
      return;
    }
    const row = e.target.closest('.skill-row');
    if (row) {
      state.skillSel = row.dataset.skill;
      renderSkills();
      return;
    }
  });
  // Filter without re-rendering the input (it would lose focus).
  view.addEventListener('input', (e) => {
    if (e.target.id !== 'skill-filter') return;
    state.skillQuery = e.target.value;
    const rows = $('#skill-rows');
    if (rows) rows.innerHTML = skillRowsHtml();
  });
}

async function loadSkills(refresh = false) {
  const view = $('#view-skills');
  if (!state.skillsList || refresh) {
    if (!state.skillsList) view.innerHTML = '<div class="gh-unavailable">Loading…</div>';
    try {
      state.skillsList = refresh
        ? await fetch('/api/skills/refresh', { method: 'POST' }).then((r) => {
            if (!r.ok) throw new Error(`refresh → ${r.status}`);
            return r.json();
          })
        : await getJson('/api/skills');
      if (refresh) alertBar('Team skills refreshed.');
      renderTaskPills(); // the form's source pill lists the same catalog
    } catch (err) {
      view.innerHTML = `<div class="gh-unavailable">✗ ${esc(err.message)}</div>`;
      return;
    }
  }
  renderSkills();
}

function filteredSkills() {
  const q = state.skillQuery.trim().toLowerCase();
  return (state.skillsList ?? []).filter(
    (s) => !q || s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
  );
}

function skillRowsHtml() {
  const skills = filteredSkills();
  const rows = skills
    .map(
      (s) => `
      <div class="skill-row ${state.skillSel === s.name ? 'selected' : ''}" data-skill="${esc(s.name)}">
        <div class="row1">
          <svg viewBox="0 0 24 24"><path d="${SKILL_ICON}"/></svg>
          <span class="name">${esc(s.name)}</span>
          <span class="skill-tag ${esc(s.source)}">${esc(s.source)}</span>
        </div>
        ${s.description ? `<div class="desc">${esc(s.description)}</div>` : ''}
      </div>`,
    )
    .join('');
  const empty = state.skillsList?.length
    ? '<div class="dim" style="padding:12px">(no skills match)</div>'
    : `<div class="dim" style="padding:12px;font-size:12px;line-height:1.6">No skills yet. Drop Markdown files into <span class="mono">.ai/skills/</span> or <span class="mono">.ai/cezar/skills/</span> — optional frontmatter: <span class="mono">name</span>, <span class="mono">description</span>. Team skills from your skills repo appear here too — try ⟳ Refresh.</div>`;
  return rows || empty;
}

/* Always-visible entry below the (scrollable) skill list — spec 011 must not
   drown under a long team catalog. */
function bookmarkletRowHtml() {
  return `
    <div class="skill-row pinned ${state.skillSel === '__bm' ? 'selected' : ''}" data-skill="__bm">
      <div class="row1">
        <svg viewBox="0 0 24 24" style="stroke:var(--accent)"><path d="M13 2L4.5 13.5h5.5L9 22l8.5-11.5H12L13 2z"/></svg>
        <span class="name">Run from GitHub</span>
        <span class="skill-tag">bookmarklets</span>
      </div>
      <div class="desc">One-click skill launch from any GitHub PR or issue.</div>
    </div>`;
}

/* Workflows referencing this skill — "fix-and-verify › Verify". */
function skillUsedBy(name) {
  const out = [];
  for (const w of state.workflows) {
    for (const s of w.steps ?? []) {
      if (s.skill === name) out.push(`${w.name} › ${s.name ?? s.id}`);
    }
  }
  return out;
}

function renderSkills() {
  const view = $('#view-skills');
  const skills = state.skillsList ?? [];
  if (state.skillSel !== '__bm' && !skills.some((s) => s.name === state.skillSel)) {
    state.skillSel = skills[0]?.name ?? '__bm';
  }

  view.innerHTML = `
    <div class="split">
      <div class="split-list">
        <div class="split-head">
          <div class="head-row">
            <h1>Skills</h1>
            <button id="skills-refresh" class="btn-ghost" style="margin-left:auto;height:27px;font-size:12px" title="git fetch the team skills repos">⟳ Refresh</button>
          </div>
        </div>
        <input id="skill-filter" class="filter-input" placeholder="Filter skills…" value="${esc(state.skillQuery)}">
        <div class="split-rows" id="skill-rows">${skillRowsHtml()}</div>
        <div class="list-foot">${bookmarkletRowHtml()}</div>
      </div>
      <div class="split-detail" id="skill-detail">${state.skillSel === '__bm' ? bookmarkletShellHtml() : skillDetailHtml()}</div>
    </div>`;

  if (state.skillSel === '__bm') void bindBookmarklets(skills);
}

function skillDetailHtml() {
  const skill = (state.skillsList ?? []).find((s) => s.name === state.skillSel);
  if (!skill) return '<div class="empty">No skill selected.</div>';
  const usedBy = skillUsedBy(skill.name);
  return `
    <div class="inner skill-detail">
      <div class="title-row">
        <h1>${esc(skill.name)}</h1>
        <span class="skill-tag ${esc(skill.source)}">${esc(skill.source)}</span>
      </div>
      <div class="path-line">${esc(skill.path)}${skill.team ? ` · from ${esc(skill.team.repo)}` : ''}</div>
      ${skill.description ? `<div class="desc">${esc(skill.description)}</div>` : ''}
      <div class="section-label">Used by</div>
      ${
        usedBy.length
          ? usedBy
              .map(
                (u) =>
                  `<div class="used-row"><svg viewBox="0 0 24 24"><path d="M4 12h12M12 6l6 6-6 6"/></svg>${esc(u)}</div>`,
              )
              .join('')
          : '<div class="dim" style="font-size:12.5px;padding:6px 0">Not referenced by any workflow yet — quick-task picks it up when the task mentions it.</div>'
      }
      <div class="content-head">
        <span class="section-label">Content</span>
        <span class="spacer"></span>
      </div>
      <pre class="content">${esc(skill.body)}</pre>
    </div>`;
}

// ---- workflow builder (spec 012) ---------------------------------------------

/* The Workflows tab: a workflow is (usually) a portable stack of skills the
   agent applies top to bottom. Drag skills in from the palette, reorder by
   drag, import/export the YAML, save to `.ai/cezar/workflows/`. Workflows
   richer than a skill stack (checks, custom prompts — YAML-land) still load,
   reorder and save; they just serialize in the full `steps:` form instead of
   the compact `skills:` one. */

const WB_MAX_STEPS = 8; // the server's save/run step limit

function wbEmpty() {
  return {
    name: 'my-workflow',
    description: '',
    steps: [],
    query: '',
    importOpen: false,
    importText: '',
    importError: '',
    copied: false,
  };
}

function wbFrom(w) {
  return {
    ...wbEmpty(),
    name: w.name,
    description: w.description ?? '',
    steps: structuredClone(w.steps ?? []),
  };
}

/* First visit seeds the canvas with the repo's first saved workflow — "open
   the tab, see your flow". No files yet → an empty canvas + the drop hint. */
function openWorkflowsView() {
  if (!state.wb) {
    const first = state.workflows.find((w) => w.source === 'file');
    state.wb = first ? wbFrom(first) : wbEmpty();
  }
  renderWorkflowsView();
}

/* Client mirror of the server's skillStackOf(): a pure "apply skill to the
   task" chain can be written in the compact `skills:` YAML form. */
function wbSkillStack(steps) {
  const skills = [];
  for (const s of steps) {
    if (s.command || !s.skill) return null;
    if (s.prompt !== undefined && s.prompt !== '{{task}}') return null;
    if (s.name !== undefined && s.name !== s.skill) return null;
    if (s.model || s.allowedTools || s.bashAllowlist || s.onFail) return null;
    skills.push(s.skill);
  }
  return skills.length ? skills : null;
}

/* Quote only when the plain form would be ambiguous YAML — special characters,
   or a scalar YAML would read as a boolean/number/null instead of a string.
   JSON strings are valid YAML double-quoted scalars, so JSON.stringify is the
   escape hatch. */
function yamlScalar(v) {
  const s = String(v);
  const plain = /^[A-Za-z0-9._][A-Za-z0-9 ._/-]*$/.test(s) && !s.endsWith(' ');
  const looksTyped = /^(true|false|yes|no|on|off|null|~)$/i.test(s) || /^[-+.]?\d/.test(s);
  return plain && !looksTyped ? s : JSON.stringify(s);
}

function yamlBlock(key, text, indent) {
  const pad = ' '.repeat(indent);
  if (!text.includes('\n')) return [`${pad}${key}: ${yamlScalar(text)}`];
  return [`${pad}${key}: |`, ...text.split('\n').map((l) => `${pad}  ${l}`)];
}

function wbYamlText() {
  const wb = state.wb;
  const lines = [`name: ${yamlScalar(wb.name.trim() || 'my-workflow')}`];
  if (wb.description.trim()) lines.push(...yamlBlock('description', wb.description.trim(), 0));
  const stack = wbSkillStack(wb.steps);
  if (stack) {
    lines.push('skills:');
    for (const s of stack) lines.push(`  - ${yamlScalar(s)}`);
  } else if (wb.steps.length) {
    lines.push('steps:');
    for (const s of wb.steps) {
      lines.push(`  - id: ${yamlScalar(s.id)}`);
      if (s.name && s.name !== s.id) lines.push(`    name: ${yamlScalar(s.name)}`);
      if (s.skill) lines.push(`    skill: ${yamlScalar(s.skill)}`);
      if (s.prompt) lines.push(...yamlBlock('prompt', s.prompt, 4));
      if (s.model) lines.push(`    model: ${yamlScalar(s.model)}`);
      if (s.allowedTools) lines.push(`    allowedTools: [${s.allowedTools.map(yamlScalar).join(', ')}]`);
      if (s.bashAllowlist) lines.push(`    bashAllowlist: [${s.bashAllowlist.map(yamlScalar).join(', ')}]`);
      if (s.command) lines.push(...yamlBlock('command', s.command, 4));
      if (s.onFail) {
        lines.push('    onFail:', `      retry: ${yamlScalar(s.onFail.retry)}`, `      max: ${s.onFail.max ?? 2}`);
      }
    }
  } else {
    lines.push('skills: []');
  }
  return `${lines.join('\n')}\n`;
}

function wbCountLabel() {
  const n = state.wb.steps.length;
  const noun = wbSkillStack(state.wb.steps) ? 'skill' : 'step';
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function wbGapHtml(i) {
  return `<div class="wb-gap" data-gap="${i}"><div class="wb-gap-inner">drop to insert</div></div>`;
}

function wbStepCardHtml(s, i) {
  const lib = (state.skillsList ?? []).find((k) => k.name === s.skill);
  let title;
  let desc;
  let badge = '';
  if (s.command) {
    title = s.name ?? s.id;
    desc = `$ ${s.command}${s.onFail ? ` — on fail retry from "${s.onFail.retry}" (×${s.onFail.max ?? 2})` : ''}`;
    badge = '<span class="wb-badge check">check</span>';
  } else if (s.skill) {
    title = s.skill;
    desc = lib
      ? (lib.description ?? '')
      : 'Not in this repo or the team skills — the step runs on its plain prompt.';
    if (!lib) badge = '<span class="wb-badge unknown">unknown</span>';
  } else {
    title = s.name ?? s.id;
    desc = oneLine(s.prompt ?? '', 90);
    badge = '<span class="wb-badge">prompt</span>';
  }
  const icon = s.command
    ? '<svg class="wb-ic" viewBox="0 0 24 24" style="stroke:var(--green)"><path d="M5 12l5 5 9-11"/></svg>'
    : `<svg class="wb-ic" viewBox="0 0 24 24"><path d="${SKILL_ICON}"/></svg>`;
  return `
    ${wbGapHtml(i)}
    <div class="wb-step" draggable="true" data-idx="${i}">
      <svg class="grip" width="10" height="14" viewBox="0 0 10 16"><circle cx="2.5" cy="2.5" r="1.4"/><circle cx="7.5" cy="2.5" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13.5" r="1.4"/><circle cx="7.5" cy="13.5" r="1.4"/></svg>
      <span class="num mono">${String(i + 1).padStart(2, '0')}</span>
      ${icon}
      <div class="wb-step-main">
        <div class="wb-step-name mono">${esc(title)}</div>
        ${desc ? `<div class="wb-step-desc">${esc(desc)}</div>` : ''}
      </div>
      ${badge}
      <button type="button" class="wb-remove" data-wb-remove="${i}" title="Remove from flow">×</button>
    </div>`;
}

function wbStepsHtml() {
  const steps = state.wb.steps;
  if (!steps.length) {
    return '<div class="wb-gap tall" data-gap="0"><div class="wb-gap-inner">drop a skill here — or Import a workflow.yaml</div></div>';
  }
  return `${steps.map(wbStepCardHtml).join('')}${wbGapHtml(steps.length)}
    <div class="wb-flow-note"><svg viewBox="0 0 24 24" width="12" height="12"><path d="M12 5v14M6 13l6 6 6-6"/></svg>runs top to bottom</div>`;
}

function wbPaletteHtml() {
  const q = state.wb.query.trim().toLowerCase();
  const inFlow = new Set(state.wb.steps.map((s) => s.skill).filter(Boolean));
  const skills = (state.skillsList ?? []).filter(
    (s) => !q || s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
  );
  if (!skills.length) {
    return (state.skillsList ?? []).length
      ? '<div class="dim" style="font-size:11.5px;padding:4px 2px 8px">No skills match.</div>'
      : '<div class="dim" style="font-size:11.5px;padding:4px 2px 8px;line-height:1.6">No skills yet — drop Markdown files into <span class="mono">.ai/skills/</span> or <span class="mono">.ai/cezar/skills/</span>.</div>';
  }
  return skills
    .map(
      (s) => `
    <div class="wb-skill" draggable="true" data-skill="${esc(s.name)}" title="${esc(s.description ?? '')}">
      <svg class="wb-ic" viewBox="0 0 24 24"><path d="${SKILL_ICON}"/></svg>
      <span class="name mono">${esc(s.name)}</span>
      <span class="wb-skill-right">
        ${inFlow.has(s.name) ? '<svg class="in-flow" viewBox="0 0 24 24"><path d="M5 12l5 5 9-11"/></svg>' : ''}
        <svg class="dots" viewBox="0 0 24 24"><circle cx="9" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="19" r="1.6"/></svg>
      </span>
    </div>`,
    )
    .join('');
}

function wbLoadChipsHtml() {
  const chips = state.workflows
    .map(
      (w) =>
        `<button type="button" class="chip-toggle ${state.wb.name === w.name ? 'on' : ''}" data-wb-load="${esc(w.name)}" title="${esc(w.description ?? '')}">${esc(w.name)}</button>`,
    )
    .join('');
  return `<span class="wb-k">edit</span>${chips}<button type="button" class="chip-toggle" data-wb-load="__new" title="Start an empty workflow">+ new</button>`;
}

function renderWorkflowsView() {
  const wb = state.wb;
  $('#view-workflows').innerHTML = `
    <div class="wb-grid">
      <div class="wb-main"><div class="wb-inner">
        <div class="wb-head">
          <h1>Workflow builder</h1>
          ${
            state.workflows.some((w) => w.name === wb.name.trim() && w.source === 'file')
              ? `<button type="button" class="btn-text danger" data-wb-action="delete" title="Delete the saved workflow file">${BI.trash}Delete</button>`
              : ''
          }
          <button type="button" class="btn-text" data-wb-action="import">⬆ Import</button>
          <button type="button" class="btn-text" data-wb-action="export">⬇ Export</button>
          <button type="button" class="btn-dark" data-wb-action="save">✓ Save</button>
        </div>
        <div class="wb-meta">
          <div class="wb-name-pill">
            <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13"/></svg>
            <input id="wb-name" value="${esc(wb.name)}" spellcheck="false" aria-label="Workflow name">
          </div>
          <span class="mono dim" id="wb-count">${wbCountLabel()}</span>
        </div>
        <div class="wb-load" id="wb-load">${wbLoadChipsHtml()}</div>
        <div class="wb-import" ${wb.importOpen ? '' : 'hidden'}>
          <div class="wb-import-label">Import workflow YAML</div>
          <textarea id="wb-import-text" rows="6" spellcheck="false" placeholder="name: my-flow&#10;skills:&#10;  - test-conventions&#10;  - commit-style">${esc(wb.importText)}</textarea>
          <div class="error-text" style="margin-top:7px" ${wb.importError ? '' : 'hidden'}>${esc(wb.importError)}</div>
          <div class="wb-import-actions">
            <button type="button" class="btn-dark" data-wb-action="do-import">Import</button>
            <button type="button" class="btn-ghost" data-wb-action="cancel-import">Cancel</button>
          </div>
        </div>
        <div id="wb-steps">${wbStepsHtml()}</div>
      </div></div>
      <aside class="wb-aside">
        <div class="section-label" style="margin:0 0 4px">Skills</div>
        <div class="wb-hint">Drag into the flow. Order is execution order — the agent applies them top to bottom.</div>
        <input id="wb-filter" class="filter-input" style="width:100%;margin:0 0 9px" placeholder="Filter skills…" value="${esc(wb.query)}">
        <div id="wb-palette">${wbPaletteHtml()}</div>
        <div class="wb-yaml-head">
          <span class="section-label" style="margin:0">workflow.yaml</span>
          <span class="spacer"></span>
          <button type="button" class="btn-text" id="wb-copy" data-wb-action="copy">${wb.copied ? '✓ Copied' : 'Copy'}</button>
        </div>
        <pre class="wb-yaml" id="wb-yaml"></pre>
        <div class="wb-note">
          <svg viewBox="0 0 24 24" width="12" height="12"><circle cx="12" cy="12" r="9"/><path d="M12 8v.5M12 11v5"/></svg>
          <span>Portable — export this file and import it in any repo running cezar.</span>
        </div>
      </aside>
    </div>`;
  $('#wb-yaml').textContent = wbYamlText();
}

/* Structural change (add/move/remove/save): refresh the pieces that depend on
   the step list without touching the inputs — they keep focus. */
function wbRefresh() {
  $('#wb-steps').innerHTML = wbStepsHtml();
  $('#wb-palette').innerHTML = wbPaletteHtml();
  $('#wb-count').textContent = wbCountLabel();
  $('#wb-load').innerHTML = wbLoadChipsHtml();
  $('#wb-yaml').textContent = wbYamlText();
}

function wbSkillStep(skill, steps) {
  const used = new Set(steps.map((s) => s.id));
  let id = skill;
  for (let n = 2; used.has(id); n++) id = `${skill}-${n}`;
  return { id, name: skill, skill, prompt: '{{task}}' };
}

function bindWorkflowsView() {
  const view = $('#view-workflows');

  view.addEventListener('click', (e) => {
    if (!state.wb) return;
    const rm = e.target.closest('[data-wb-remove]');
    if (rm) {
      state.wb.steps.splice(Number(rm.dataset.wbRemove), 1);
      wbRefresh();
      return;
    }
    const load = e.target.closest('[data-wb-load]');
    if (load) {
      const name = load.dataset.wbLoad;
      const w = state.workflows.find((x) => x.name === name);
      state.wb = name === '__new' ? wbEmpty() : w ? wbFrom(w) : state.wb;
      renderWorkflowsView();
      return;
    }
    const btn = e.target.closest('[data-wb-action]');
    if (!btn) return;
    const action = btn.dataset.wbAction;
    if (action === 'import') {
      state.wb.importOpen = !state.wb.importOpen;
      state.wb.importError = '';
      renderWorkflowsView();
      if (state.wb.importOpen) $('#wb-import-text')?.focus();
    } else if (action === 'cancel-import') {
      state.wb.importOpen = false;
      state.wb.importText = '';
      state.wb.importError = '';
      renderWorkflowsView();
    } else if (action === 'do-import') void wbImport(btn);
    else if (action === 'export') wbExport();
    else if (action === 'copy') wbCopy();
    else if (action === 'save') void wbSave(btn);
    else if (action === 'delete') void wbDelete(btn);
  });

  view.addEventListener('input', (e) => {
    if (!state.wb) return;
    if (e.target.id === 'wb-name') {
      state.wb.name = e.target.value;
      $('#wb-yaml').textContent = wbYamlText();
      $('#wb-load').innerHTML = wbLoadChipsHtml();
    } else if (e.target.id === 'wb-filter') {
      state.wb.query = e.target.value;
      $('#wb-palette').innerHTML = wbPaletteHtml();
    } else if (e.target.id === 'wb-import-text') {
      state.wb.importText = e.target.value;
    }
  });

  // Drag & drop — palette pills copy in, step cards move; gaps between cards
  // are the drop targets. Class flips only (no re-render mid-drag: replacing
  // the dragged node cancels an HTML5 drag).
  view.addEventListener('dragstart', (e) => {
    const skill = e.target.closest('.wb-skill');
    const step = e.target.closest('.wb-step');
    if (!skill && !step) return;
    try {
      e.dataTransfer.setData('text/plain', 'x'); // Firefox needs data to drag
      e.dataTransfer.effectAllowed = skill ? 'copyMove' : 'move';
    } catch {
      // older engines — the drag still works
    }
    state.wbDrag = skill
      ? { from: 'palette', skill: skill.dataset.skill }
      : { from: 'step', index: Number(step.dataset.idx) };
    // Deferred: repainting the dragged node in the same tick aborts the drag.
    setTimeout(() => {
      view.classList.add('wb-dragging');
      step?.classList.add('drag-src');
    }, 0);
  });
  view.addEventListener('dragover', (e) => {
    const gap = e.target.closest('.wb-gap');
    if (!gap || !state.wbDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = state.wbDrag.from === 'palette' ? 'copy' : 'move';
    gap.classList.add('over');
  });
  view.addEventListener('dragleave', (e) => {
    e.target.closest('.wb-gap')?.classList.remove('over');
  });
  view.addEventListener('drop', (e) => {
    const gap = e.target.closest('.wb-gap');
    const d = state.wbDrag;
    state.wbDrag = null;
    view.classList.remove('wb-dragging');
    if (!gap || !d) return;
    e.preventDefault();
    const at = Number(gap.dataset.gap);
    const steps = state.wb.steps;
    if (d.from === 'step') {
      const [moved] = steps.splice(d.index, 1);
      steps.splice(d.index < at ? at - 1 : at, 0, moved);
    } else {
      if (steps.length >= WB_MAX_STEPS) {
        alertBar(`A workflow holds at most ${WB_MAX_STEPS} steps.`);
        wbRefresh();
        return;
      }
      steps.splice(at, 0, wbSkillStep(d.skill, steps));
    }
    wbRefresh();
  });
  view.addEventListener('dragend', () => {
    state.wbDrag = null;
    view.classList.remove('wb-dragging');
    for (const el of view.querySelectorAll('.over, .drag-src')) el.classList.remove('over', 'drag-src');
  });
}

async function wbImport(btn) {
  const text = state.wb.importText.trim();
  if (!text) {
    $('#wb-import-text')?.focus();
    return;
  }
  btn.disabled = true;
  try {
    const res = await fetch('/api/workflows/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    state.wb = { ...wbEmpty(), name: data.name, description: data.description ?? '', steps: data.steps };
    renderWorkflowsView();
    alertBar(`Imported "${data.name}" — review, then Save.`);
  } catch (err) {
    state.wb.importError = err.message;
    renderWorkflowsView();
  } finally {
    btn.disabled = false;
  }
}

function wbSlug() {
  return (
    state.wb.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workflow'
  );
}

function wbExport() {
  const blob = new Blob([wbYamlText()], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${wbSlug()}.yaml`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let wbCopyTimer = null;
function wbCopy() {
  void navigator.clipboard?.writeText(wbYamlText()).catch(() => {});
  state.wb.copied = true;
  const btn = $('#wb-copy');
  if (btn) btn.textContent = '✓ Copied';
  clearTimeout(wbCopyTimer);
  wbCopyTimer = setTimeout(() => {
    if (state.wb) state.wb.copied = false;
    const b = $('#wb-copy');
    if (b) b.textContent = 'Copy';
  }, 1600);
}

async function wbSave(btn) {
  const wb = state.wb;
  const name = wb.name.trim();
  if (!name) {
    $('#wb-name')?.focus();
    return;
  }
  if (!wb.steps.length) {
    alertBar('Add at least one step first.');
    return;
  }
  const stack = wbSkillStack(wb.steps);
  const body = {
    name,
    ...(wb.description.trim() ? { description: wb.description.trim() } : {}),
    ...(stack ? { skills: stack } : { steps: wb.steps }),
  };
  const post = (payload) =>
    fetch('/api/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  btn.disabled = true;
  try {
    let res = await post(body);
    let data = await res.json();
    if (res.status === 409 && data.exists) {
      if (!confirm(`"${name}" already exists — overwrite it?`)) return;
      res = await post({ ...body, overwrite: true });
      data = await res.json();
    }
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    alertBar(`Saved — ${String(data.path).split('/').pop()}`);
    const workflowsRes = await getJson('/api/workflows');
    setWorkflowOptions(workflowsRes.workflows);
    renderWorkflowsView(); // chips + the Delete button now reflect the file
  } catch (err) {
    alertBar(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function wbDelete(btn) {
  const name = state.wb.name.trim();
  const fileWf = state.workflows.find((w) => w.name === name && w.source === 'file');
  if (!fileWf) return;
  if (!confirm(`Delete workflow "${name}" (${String(fileWf.path ?? '').split('/').pop()})?`)) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/workflows/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    alertBar(`Deleted "${name}".`);
    const workflowsRes = await getJson('/api/workflows');
    setWorkflowOptions(workflowsRes.workflows);
    state.wb = wbEmpty();
    renderWorkflowsView();
  } catch (err) {
    alertBar(err.message);
    btn.disabled = false;
  }
}

// ---- bookmarklet generator (spec 011) ------------------------------------------

/* The javascript: URL dragged to the bookmarks bar. On a GitHub PR/issue it
   scans localhost:4321–4330 for cockpits (GET /api/health, 800 ms timeout,
   CORS-enabled server-side), picks the one whose repo.remote matches the
   page's owner/repo (fallback: first alive) and opens /new there. The whole
   program is one URI-encoded expression — no external state. */
function bookmarkletUrl(skillName, auto, key) {
  const enc = (s) => encodeURIComponent(s).replaceAll("'", '%27'); // ' survives encodeURIComponent — would break the JS string
  const query = `${skillName ? `skill=${enc(skillName)}&` : ''}auto=${auto ? '1' : '0'}&key=${enc(key)}&ref=`;
  const code =
    `(async()=>{const m=location.href.match(/^https:\\/\\/github\\.com\\/([^\\/]+)\\/([^\\/]+)\\/(pull|issues)\\/\\d+/);` +
    `if(!m){alert('Open a GitHub PR or issue first');return;}` +
    `const q='${query}'+encodeURIComponent(location.href);` +
    `const f=async p=>{try{const c=new AbortController();setTimeout(()=>c.abort(),800);` +
    `const r=await fetch('http://localhost:'+p+'/api/health',{signal:c.signal});const h=await r.json();` +
    `return{p,remote:(h.repo&&h.repo.remote)||''}}catch(e){return null}};` +
    `const rs=(await Promise.all([4321,4322,4323,4324,4325,4326,4327,4328,4329,4330].map(f))).filter(Boolean);` +
    `if(!rs.length){alert('cezar cockpit is not running - start it with: npx cezar');return;}` +
    `const t=rs.find(r=>r.remote.includes(m[1]+'/'+m[2]))||rs[0];` +
    `open('http://localhost:'+t.p+'/new?'+q,'_blank');})();`;
  return `javascript:${encodeURIComponent(code)}`;
}

function bookmarkletShellHtml() {
  return `
      <div class="inner" id="bm-panel">
        <h1>Run from GitHub</h1>
        <div class="bm-help">Drag a button below to your browser's bookmarks bar.
        On any GitHub PR or issue, click it — it finds your running cockpit on
        localhost (ports 4321–4330) and picks the one serving that repo.
        The cockpit must be running: <span class="mono">npx cezar</span>.</div>
        <label class="bm-auto"><input type="checkbox" id="bm-auto">
          One-click launch (auto-submit) <span class="dim">— re-drag the buttons after changing this</span></label>
        <div id="bm-generic"></div>
        <input id="bm-filter" class="bm-filter" placeholder="Filter skills…">
        <div id="bm-list"></div>
      </div>`;
}

function bmRowHtml(label, url, hint) {
  return `
      <div class="bm-row">
        <a class="bm" draggable="true" href="${esc(url)}" title="Drag me to your bookmarks bar">⚡ ${esc(label)}</a>
        <button type="button" class="bm-copy" data-copy="${esc(url)}" title="Copy the bookmarklet URL">Copy</button>
        ${hint ? `<span class="dim bm-hint">${esc(hint)}</span>` : ''}
      </div>`;
}

function renderBmLinks(skills) {
  const key = state.launchKey ?? '';
  // Generic launcher: no skill, auto forced off — it only prefills the form.
  $('#bm-generic').innerHTML = bmRowHtml(
    'cezar: this PR/issue',
    bookmarkletUrl('', false, key),
    'prefills the form — nothing starts by itself',
  );
  const filter = state.bmFilter.trim().toLowerCase();
  const filtered = skills.filter((s) => s.name.toLowerCase().includes(filter));
  $('#bm-list').innerHTML = filtered.length
    ? filtered
        .map((s) => bmRowHtml(`/${s.name}`, bookmarkletUrl(s.name, state.bmAuto, key), s.source))
        .join('')
    : `<div class="dim">${skills.length ? '(no skills match)' : '(no skills yet — the generic launcher above still works)'}</div>`;
}

async function bindBookmarklets(skills) {
  if (state.launchKey === null) {
    try {
      state.launchKey = (await getJson('/api/launch-key')).key;
    } catch {
      state.launchKey = ''; // degraded: bookmarklets still work, auto-start won't
    }
  }
  const panel = $('#bm-panel');
  if (!panel) return; // skills view re-rendered meanwhile
  const autoBox = $('#bm-auto');
  autoBox.checked = state.bmAuto;
  autoBox.addEventListener('change', () => {
    state.bmAuto = autoBox.checked;
    renderBmLinks(skills);
  });
  const filterBox = $('#bm-filter');
  filterBox.value = state.bmFilter;
  filterBox.addEventListener('input', () => {
    state.bmFilter = filterBox.value;
    renderBmLinks(skills);
  });
  panel.addEventListener('click', async (e) => {
    const link = e.target.closest('a.bm');
    if (link) {
      // The cockpit page never executes the javascript: URL itself — the
      // links are only a drag source (spec 011 §5).
      e.preventDefault();
      alertBar('Drag me to your bookmarks bar');
      return;
    }
    const copy = e.target.closest('button[data-copy]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        alertBar('Bookmarklet URL copied.');
      } catch {
        alertBar('Copy failed — drag the button instead.');
      }
    }
  });
  renderBmLinks(skills);
}

init().catch((err) => {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div style="position:fixed;bottom:12px;left:12px;color:#f85149">init failed: ${esc(err.message)}</div>`,
  );
});
