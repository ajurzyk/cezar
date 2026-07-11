/**
 * The backend-agnostic seam for running one agent task. Adapted from
 * @cezar/core's `agents/agent-runner.ts`, trimmed for single-user local use:
 * no token-budget circuit breaker, no zod response schemas — one run is one
 * `claude` CLI invocation streaming normalized events.
 */

export type AgentBackend = 'claude-cli';

export interface AgentRunSpec {
  /** Appended to the CLI's default system prompt (`--append-system-prompt`). */
  systemPrompt?: string;
  userPrompt: string;
  /** Image blocks delivered with the first user message — screenshots pasted
   *  into the new-task form (spec 002's paste path, at task start). */
  images?: ContentBlock[];
  /** The directory the agent runs in — also the only writable root. */
  cwd: string;
  /** Tool allowlist; the CLI is default-deny for anything not listed. */
  allowedTools?: string[];
  /** When `Bash` is allowed, restrict it to commands starting with one of these. */
  bashAllowlist?: string[];
  /** Extra directories the agent may read/write besides `cwd`. */
  additionalDirectories?: string[];
  /** Extra env vars for the agent process (merged over `process.env`) —
   *  e.g. CEZ_HANDOFF_FILE / CEZ_TODOS_FILE / CEZ_TASK_ID (spec 007). */
  env?: Record<string, string>;
  model?: string;
  /** Wall-clock kill switch for the run (ms). */
  timeoutMs?: number;
  /**
   * Stable session id (UUID) so the user can take over interactively later:
   * `cd <repo> && claude --resume <sessionId>`.
   */
  sessionId?: string;
  /**
   * Spawn `claude --resume <sessionId>` instead of starting a fresh session —
   * picks up the on-disk conversation (used by "Continue" after a run ends).
   */
  resume?: boolean;
}

/** One content block of a user message — mirrors the Anthropic wire format
 *  so it can be written to the claude CLI's stdin verbatim. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** Normalized event stream — the GUI renders these, the store persists them. */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; tool: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; result: string; isError: boolean }
  /** An image inside a tool result (screenshot tools, Read on a PNG…) —
   *  raw base64 here; the run manager persists it and re-emits a URL. */
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'token-usage'; tokensUsed: number }
  | { type: 'cost'; usd: number }
  | { type: 'turn-end' }
  | { type: 'note'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface AgentToolCallRecord {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentRunResult {
  /** Concatenated assistant text across the run, trimmed. */
  text: string;
  toolCalls: AgentToolCallRecord[];
  /** Cost-weighted token usage; 0 when the backend surfaced no telemetry. */
  tokensUsed: number;
  sessionId?: string;
}

export interface AgentRunner {
  readonly backend: AgentBackend;
  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult>;
  interrupt(): Promise<void>;
}
