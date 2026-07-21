import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
} from './agent-runner.js';
import { prependSystemPrompt } from './agent-runner.js';
import {
  AUTO_END_DELAY_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  EOF_KILL_GRACE_MS,
  EOF_TERM_GRACE_MS,
  KILL_GRACE_MS,
} from './claude-cli-runner.js';
import { buildChildEnv } from './agent-env.js';
import { readNdjson } from './ndjson.js';
import {
  codexSessionStarted,
  createCodexUiState,
  mapCodexNotification,
  type CodexUiMapping,
  type CodexUiMapperState,
} from './codex-ui-mapper.js';

export interface CodexRunnerOptions {
  /** Override the binary name/path; defaults to `codex` on PATH. */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

/**
 * `AgentRunner` over `codex app-server` — the same JSONL transport the VS Code
 * extension and desktop app use (JSON-RPC 2.0, newline-delimited, over
 * stdin/stdout). One long-lived process per session gives Codex the same
 * multi-turn shape as the Claude runner: `turn/start` for a new turn,
 * `turn/steer` for a mid-turn follow-up, `turn/interrupt` to cancel, and
 * `thread/resume` to reopen a stored thread for "Continue".
 *
 * Auth = the host's logged-in ChatGPT/Codex session (or CODEX_API_KEY). The
 * agent runs autonomously via `sandbox: workspace-write` + `approvalPolicy:
 * never` — Codex has no per-tool allowlist, so `spec.allowedTools` is ignored.
 */
export class CodexAppServerRunner implements AgentRunner {
  readonly backend = 'codex' as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: CodexSession | null = null;

  constructor(opts: CodexRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.CEZ_CODEX_BIN ?? 'codex';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    const session = new CodexSession(this.bin, this.timeoutMs, spec, onEvent, opts);
    this.lastSession = session;
    return session;
  }
}

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

/** One live `codex app-server` process driving a single thread. */
class CodexSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;

  private readonly child!: ChildProcessWithoutNullStreams;
  private stdinOpen = true;
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private readonly textChunks: string[] = [];
  /** agentMessage item ids that streamed deltas — so `item/completed` for the
   *  same item doesn't re-emit the full text on top of the deltas. */
  private readonly streamedItems = new Set<string>();
  private tokensUsed = 0;
  private ready!: Promise<void>;
  private autoEndTimer: NodeJS.Timeout | undefined;
  private eofTermTimer: NodeJS.Timeout | undefined;
  private eofKillTimer: NodeJS.Timeout | undefined;
  private spawnFailed: Error | null = null;
  private timedOut = false;
  /** Protocol v2 emission — additive alongside v1 (`onEvent` keeps flowing
   *  byte-identical); the channel is `opts.onUiEvent` (RunManager wiring
   *  lands in R2 step 2.1). */
  private uiState: CodexUiMapperState = createCodexUiState();

  constructor(
    private readonly bin: string,
    timeoutMs: number,
    private readonly spec: AgentRunSpec,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
  ) {
    try {
      // Give the workspace-write sandbox network access so agent tools that need the network
      // (gh, npm, git over https) work — otherwise `gh` fails with "error connecting to
      // api.github.com" under codex while the same tool works under claude (#codex-network).
      // `-c` is codex's documented config override (dotted key, TOML value); opt out with
      // CEZ_CODEX_NETWORK=0.
      const args = ['app-server'];
      if (process.env.CEZ_CODEX_NETWORK !== '0') {
        args.push('-c', 'sandbox_workspace_write.network_access=true');
      }
      this.child = nodeSpawn(bin, args, {
        cwd: spec.cwd,
        env: buildChildEnv({ backend: 'codex', extraEnv: spec.env }),
      });
    } catch (err) {
      throw wrapSpawnError(err, bin);
    }

    this.child.on('error', (err: NodeJS.ErrnoException) => {
      this.spawnFailed = wrapSpawnError(err, bin);
    });
    const stderrChunks: string[] = [];
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    // Optional wall-clock kill switch (disabled for interactive sessions).
    const limitMs = spec.timeoutMs ?? timeoutMs;
    let killTimer: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    if (limitMs > 0) {
      deadline = setTimeout(() => {
        this.timedOut = true;
        this.interrupt();
        this.child.stdout.destroy();
        killTimer = setTimeout(() => {
          if (this.child.exitCode == null && !this.child.killed) this.child.kill('SIGKILL');
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      }, limitMs);
      deadline.unref?.();
    }

    // Handshake → thread → first turn. Kicked off concurrently with the read
    // loop below (which resolves the request() promises this awaits).
    this.ready = this.bootstrap();

    this.result = (async (): Promise<AgentRunResult> => {
      let sessionError: unknown;
      try {
        const readLoop = async () => {
          for await (const line of readNdjson(this.child.stdout)) {
            if (this.timedOut) break;
            let msg: JsonRpcMessage;
            try {
              msg = JSON.parse(line) as JsonRpcMessage;
            } catch {
              continue; // not JSON-RPC — skip
            }
            this.emitUi((state) => mapCodexNotification(msg, state));
            this.dispatch(msg);
          }
        };
        // Start consuming stdout before awaiting bootstrap: JSON-RPC responses
        // read here settle the initialize/thread/turn requests. Owning both
        // promises makes every bootstrap rejection part of session.result.
        await Promise.all([this.ready, readLoop()]);
      } catch (err) {
        if (!this.timedOut) {
          sessionError = err;
          // Bootstrap failed before a usable turn exists. Closing stdin lets
          // app-server exit normally; end() also owns the TERM/KILL watchdog
          // if a broken child ignores EOF.
          this.end();
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
        this.stdinOpen = false;
      }

      const exitCode = await waitForExit(this.child);
      if (this.eofTermTimer) clearTimeout(this.eofTermTimer);
      if (this.eofKillTimer) clearTimeout(this.eofKillTimer);
      for (const p of this.pending.values()) p.reject(new Error('codex app-server exited'));
      this.pending.clear();

      if (this.spawnFailed) throw this.spawnFailed;
      if (sessionError) throw sessionError;

      const text = this.textChunks.join('\n').trim();
      const base: AgentRunResult = {
        text,
        toolCalls: this.toolCalls,
        tokensUsed: this.tokensUsed,
        sessionId: this.threadId ?? spec.sessionId,
      };

      if (this.timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        this.emit({ type: 'error', message: `codex app-server timed out after ${mins}m and was killed` });
        this.emit({ type: 'done' });
        return base;
      }

      if (exitCode !== 0 && exitCode !== null) {
        const stderr = stderrChunks.join('').trim();
        const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
        const message = `codex app-server exited with code ${exitCode}${detail}`;
        this.emit({ type: 'error', message });
        throw new Error(message);
      }

      this.emit({ type: 'done' });
      return base;
    })();
  }

  get open(): boolean {
    return this.stdinOpen;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.stdinOpen) return false;
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
    const text = textOf(content);
    if (!text) return true;
    // Wait for the thread to exist, then steer the live turn or start a new one.
    void this.ready
      .then(() => this.startOrSteerTurn(text))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'note', message: `codex: turn failed: ${message}` });
      });
    return true;
  }

  end(): void {
    if (!this.stdinOpen) return;
    this.stdinOpen = false;
    try {
      this.child.stdin.end();
    } catch {
      // already gone
    }
    this.eofTermTimer = setTimeout(() => {
      if (this.child.exitCode == null && !this.child.killed) this.child.kill('SIGTERM');
      this.eofKillTimer = setTimeout(() => {
        if (this.child.exitCode == null && !this.child.killed) this.child.kill('SIGKILL');
      }, EOF_KILL_GRACE_MS);
      this.eofKillTimer.unref?.();
    }, EOF_TERM_GRACE_MS);
    this.eofTermTimer.unref?.();
  }

  interrupt(): void {
    this.stdinOpen = false;
    // Best-effort graceful cancel of the in-flight turn, then hard stop.
    if (this.threadId && this.activeTurnId) {
      void this.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId }).catch(
        () => undefined,
      );
    }
    if (!this.child.killed) this.child.kill('SIGTERM');
  }

  // ---- protocol -----------------------------------------------------------

  private async bootstrap(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'cezar', title: 'cezar', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});

    const overrides = {
      model: this.spec.model,
      cwd: this.spec.cwd,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    };
    if (this.spec.resume && this.spec.sessionId) {
      await this.request('thread/resume', { threadId: this.spec.sessionId, ...clean(overrides) });
      this.threadId = this.spec.sessionId;
    } else {
      const res = await this.request('thread/start', clean(overrides));
      this.threadId = threadIdOf(res) ?? this.spec.sessionId;
    }
    if (this.threadId) {
      this.emit({ type: 'session', sessionId: this.threadId });
      // The result path (thread/start response, or thread/resume which sends
      // no thread/started notification) — deduplicated inside the mapper.
      const threadId = this.threadId;
      this.emitUi((state) => codexSessionStarted(threadId, state));
    }

    // Seed the first turn. The system prompt (skill body + handoff contract)
    // has no dedicated app-server field, so it rides along as a leading block
    // of the opening message.
    const first = prependSystemPrompt(this.spec.systemPrompt, this.spec.userPrompt);
    await this.startOrSteerTurn(first);
  }

  private async startOrSteerTurn(text: string): Promise<void> {
    if (!this.threadId) return;
    const input = [{ type: 'text', text, text_elements: [] }];
    if (this.activeTurnId) {
      await this.request('turn/steer', {
        threadId: this.threadId,
        input,
        expectedTurnId: this.activeTurnId,
      });
      return;
    }
    const res = await this.request('turn/start', { threadId: this.threadId, input });
    this.activeTurnId = turnIdOf(res) ?? this.activeTurnId;
  }

  private request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ id, method, params });
    return promise;
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(obj: unknown): void {
    if (this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // stdin gone — the read loop will settle the session
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(errorText(msg.error)));
      else p.resolve((msg.result as Record<string, unknown>) ?? {});
      return;
    }
    if (typeof msg.method === 'string') this.handleNotification(msg.method, msg.params ?? {});
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'turn/started': {
        this.activeTurnId = turnIdOf(params) ?? this.activeTurnId;
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) {
          const itemId = stringField(params, 'itemId');
          if (itemId) this.streamedItems.add(itemId);
          this.textChunks.push(delta);
          this.emit({ type: 'text', text: delta });
        }
        break;
      }
      case 'item/started': {
        const item = (params.item as Record<string, unknown>) ?? {};
        const type = stringField(item, 'type');
        // Only tool-like items become tool events; message/reasoning stream as text.
        if (type && !NON_TOOL_ITEMS.has(type)) {
          const id = stringField(item, 'id') ?? `item-${this.nextId++}`;
          this.toolCalls.push({ id, name: type, input: item });
          this.emit({ type: 'tool-call', id, tool: type, input: item });
        }
        break;
      }
      case 'item/completed': {
        const item = (params.item as Record<string, unknown>) ?? {};
        const type = stringField(item, 'type');
        const id = stringField(item, 'id') ?? '';
        if (type === 'agentMessage') {
          // Some turns only send the final item (no deltas) → emit it then.
          if (!id || !this.streamedItems.has(id)) {
            const text = typeof item.text === 'string' ? item.text : '';
            if (text) {
              this.textChunks.push(text);
              this.emit({ type: 'text', text });
            }
          }
        } else if (type && !NON_TOOL_ITEMS.has(type) && id) {
          this.emit({
            type: 'tool-result',
            toolCallId: id,
            result: safeStringify(item),
            isError: /error|failed/i.test(stringField(item, 'status') ?? ''),
          });
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const total = tokenTotal(params);
        if (total > 0) {
          this.tokensUsed = total;
          this.emit({ type: 'token-usage', tokensUsed: this.tokensUsed });
        }
        break;
      }
      case 'turn/completed': {
        this.activeTurnId = undefined;
        this.emit({ type: 'turn-end' });
        if (this.opts.autoEndAfterFirstTurn && this.stdinOpen && !this.autoEndTimer) {
          this.autoEndTimer = setTimeout(() => this.end(), AUTO_END_DELAY_MS);
          this.autoEndTimer.unref?.();
        }
        break;
      }
      default:
        break;
    }
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  /** The mapper never throws, but a defect in it must still never disturb
   *  the v1 stream — hence the belt-and-braces try. */
  private emitUi(map: (state: CodexUiMapperState) => CodexUiMapping): void {
    try {
      const mapped = map(this.uiState);
      this.uiState = mapped.state;
      if (this.opts.onUiEvent) {
        for (const event of mapped.events) this.opts.onUiEvent(event);
      }
    } catch {
      // v2 mapping is best-effort; v1 consumers stay unaffected.
    }
  }
}

// ---- helpers --------------------------------------------------------------

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** ThreadItem `type`s that are conversation text, not tool activity. */
const NON_TOOL_ITEMS = new Set(['agentMessage', 'userMessage', 'reasoning', 'plan']);

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Drop undefined values so we never send `"model": null` to the server. */
function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function threadIdOf(res: Record<string, unknown>): string | undefined {
  const thread = res.thread as { id?: unknown } | undefined;
  return typeof thread?.id === 'string' ? thread.id : stringField(res, 'threadId');
}

function turnIdOf(obj: Record<string, unknown>): string | undefined {
  const turn = obj.turn as { id?: unknown } | undefined;
  return typeof turn?.id === 'string' ? turn.id : stringField(obj, 'turnId');
}

/** Cumulative tokens from a `thread/tokenUsage/updated` notification:
 *  `params.tokenUsage.total.totalTokens`. */
function tokenTotal(params: Record<string, unknown>): number {
  const usage = params.tokenUsage as { total?: { totalTokens?: unknown } } | undefined;
  const total = usage?.total?.totalTokens;
  return typeof total === 'number' ? total : 0;
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    let done = false;
    const fin = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      resolve(code);
    };
    child.once('close', (code) => fin(code));
    child.once('exit', (code) => fin(code));
    child.once('error', () => fin(child.exitCode ?? null));
    const safety = setTimeout(
      () => fin(child.exitCode ?? null),
      EOF_TERM_GRACE_MS + EOF_KILL_GRACE_MS + KILL_GRACE_MS + 5_000,
    );
    safety.unref?.();
  });
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `\`${bin}\` not found on PATH — install the Codex CLI (npm i -g @openai/codex) and run \`codex\` once to log in`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
