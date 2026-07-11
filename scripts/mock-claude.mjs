#!/usr/bin/env node
// Mock `claude` binary for CEZ_DRY_RUN=1 — emits a plausible stream-json
// session so the engine / store / GUI can be exercised without tokens.
// Mirrors the real CLI's contract in SESSION mode: keeps reading {type:user}
// NDJSON lines from stdin, answers each with a scripted turn (assistant
// events + a terminal `result`), and exits when stdin closes (EOF).

import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

emit({ type: 'system', subtype: 'init' });

let turn = 0;

// A tiny generated PNG (320x200) standing in for a browser screenshot.
const MOCK_SCREENSHOT_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAACMklEQVR42u3csQnAIBRFUQdJY+b4tfvP4AhCLKyyghAMMRw4Ezz/bU0RBdhUMgEIGBAwIGAQMCBgQMCAgEHAgIABAYOAAQEDAgYEDAIGBAwsCLhfDdiUgEHAgIABAYOAAQEDAgYEDAIGBAwIGAT8vlEr/ImAQcACBgELGAQsYAQsYBCwgEHAAgYBe3IELGAQsIBBwAJGwAIGAQsYBCxgELCAEbCAQcACBgELGAQMAhYwCFjAIGABI2D/QgMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgIBBwCYAAQMCBgQMAgYEDAgYEDAIGBAwIGAQMCBgQMCAgEHAgIABAQMCBgEDAgYEDAIGBAwIGBAwCBgQMCBgQMAgYEDAgIBBwICAAQEDAgYBAwIGBAwCtgIIGBAwIGAQMCBgQMCAgEHAgIABAYOAeejMB/McjIAFLGABW0HAAhYwmhSwgAUsYAQsYAELGAELWMACRsACFrCAEbCABSxgBCxgAQtYwAhYwAIWMAIWsIAFjIAFLGABI2ABC1jACFjAAhYwAhawgAWMgAUsYAEjYAELWMACRsACFrCAEbCABSxgBCxgAQsYAQtYwAJGwAIWMCBgQMAgYEDAgIBBwICAAQEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgYEDAIGBAwICAQcCAgAEBAwIGAQMCBgQMCBgEDAgYEDAIGBAwIGBAwCBgQMCAgAEBg4ABAQMCBgEDAgYEDAgYBAx8xQ1bxBr9kelHqgAAAABJRU5ErkJggg==';


// Spec 007: behave like an agent that read the handoff/todos instructions —
// append a progress line to CEZ_HANDOFF_FILE and a follow-up entry to
// CEZ_TODOS_FILE, so the inbox loop is testable without tokens.
function writeHandoffAndTodo() {
  try {
    const handoff = process.env.CEZ_HANDOFF_FILE;
    if (handoff) {
      const text = readFileSync(handoff, 'utf8');
      const line = `- ${new Date().toISOString()} — mock: implemented the change (dry run)\n`;
      const marker = '## Progress log\n';
      const idx = text.indexOf(marker);
      const next =
        idx >= 0
          ? text.slice(0, idx + marker.length) + '\n' + line + text.slice(idx + marker.length).replace(/^\n+/, '')
          : text + line;
      writeFileSync(handoff, next, 'utf8');
    }
  } catch {
    // best effort — the mock still answers without a handoff file
  }
  try {
    const todosFile = process.env.CEZ_TODOS_FILE;
    if (todosFile) {
      let items = [];
      try {
        items = JSON.parse(readFileSync(todosFile, 'utf8'));
      } catch {
        items = []; // missing or broken file — start fresh, append-only
      }
      if (!Array.isArray(items)) items = [];
      items.push({
        ts: new Date().toISOString(),
        taskId: process.env.CEZ_TASK_ID,
        summary: 'Follow up: verify the mock change',
        suggestedPrompt: 'Verify the change from the previous task',
      });
      writeFileSync(todosFile, JSON.stringify(items, null, 2), 'utf8');
    }
  } catch {
    // best effort
  }
}

async function respond(userText, imageCount) {
  turn += 1;
  await sleep(250);

  // Spec 008: a planning call (marked `[cez-planner]` in the user prompt)
  // gets a canned chain plan. The `code-review` skill is deliberately made up:
  // the planner's sanitizer strips unknown skills, and the step survives on
  // its prompt — which is exactly the path worth exercising in dry runs.
  if (userText.includes('[cez-planner]')) {
    const plan = JSON.stringify({
      steps: [
        { name: 'Implement', prompt: '{{task}}' },
        { name: 'Verify', command: 'npm test' },
        { name: 'Review', skill: 'code-review', prompt: 'Review the changes for {{task}}' },
      ],
      rationale: 'Implement, verify with tests, then review.',
    });
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: plan }],
        usage: { input_tokens: 500, output_tokens: 120 },
      },
    });
    await sleep(100);
    emit({
      type: 'result',
      subtype: 'success',
      result: plan,
      usage: { input_tokens: 500, output_tokens: 120 },
      total_cost_usd: 0.0011,
    });
    return;
  }

  if (turn === 1) {
    // Leave a visible trace in the cwd (the task worktree under spec 006) so
    // the Diff view has something real to show in dry runs.
    try {
      appendFileSync('notes.md', `mock notes — ${new Date().toISOString()}: ${userText.slice(0, 100)}\n`);
    } catch {
      // read-only cwd — the mock still works, just without a diff
    }
    writeHandoffAndTodo();
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Okay — looking into: ${userText.slice(0, 120)}` }],
        usage: { input_tokens: 850, output_tokens: 40 },
      },
    });
    await sleep(300);
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu_mock_${turn}`, name: 'Bash', input: { command: 'git status --short' } }],
        usage: { input_tokens: 120, output_tokens: 55 },
      },
    });
    await sleep(300);
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `toolu_mock_${turn}`, content: ' M src/example.ts' }],
      },
    });
    await sleep(200);
    // Agent screenshot in a tool result — exercises the image pipeline
    // (persist to <id>-images/, serve via /api/runs/:id/images/, zoomable
    // card + lightbox in the transcript).
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu_mock_shot_${turn}`, name: 'Screenshot', input: { name: 'repro-login-redirect.png' } }],
        usage: { input_tokens: 80, output_tokens: 30 },
      },
    });
    await sleep(200);
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `toolu_mock_shot_${turn}`,
            content: [
              { type: 'text', text: 'Repro captured: after reload the session toast appears and you are back on /login.' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: MOCK_SCREENSHOT_B64 } },
            ],
          },
        ],
      },
    });
    await sleep(300);
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done with the first pass — opened a draft PR: https://github.com/open-mercato/demo/pull/123. Anything to adjust? (dry-run mock)' }],
        usage: { input_tokens: 300, output_tokens: 90 },
      },
    });
    await sleep(150);
    emit({
      type: 'result',
      subtype: 'success',
      result: 'Done with the first pass (dry run).',
      usage: { input_tokens: 1270, output_tokens: 185 },
      total_cost_usd: 0.0342,
    });
    return;
  }

  const imgNote = imageCount > 0 ? ` I can see ${imageCount} image(s) you attached.` : '';
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `Follow-up #${turn - 1} received: "${userText.slice(0, 100)}".${imgNote} Applied (dry run).` }],
      usage: { input_tokens: 200, output_tokens: 60 },
    },
  });
  await sleep(150);
  emit({
    type: 'result',
    subtype: 'success',
    result: `Follow-up #${turn - 1} handled (dry run).`,
    usage: { input_tokens: 200, output_tokens: 60 },
    total_cost_usd: 0.0051,
  });
}

const rl = createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let userText = '(unparseable message)';
  let imageCount = 0;
  try {
    const msg = JSON.parse(trimmed);
    const blocks = msg?.message?.content ?? [];
    userText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || '(no text)';
    imageCount = blocks.filter((b) => b.type === 'image').length;
  } catch {
    // keep placeholders
  }
  queue = queue.then(() => respond(userText, imageCount));
});
rl.on('close', () => {
  // EOF = session over; finish any in-flight turn then exit cleanly.
  queue.then(() => process.exit(0));
});
