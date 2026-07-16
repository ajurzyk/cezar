import * as clack from '@clack/prompts';
import { CANCEL, type Cancellable, type SpinnerHandle, type Ui } from './types.js';

/**
 * The interactive surface, implemented over `@clack/prompts` — the one place
 * the TUI library is imported. `types.ts`, the engine and the steps talk to
 * the `Ui` interface only, so `@clack/prompts` never enters the server/runtime
 * import graph (AGENTS.md keeps that stack tiny).
 *
 * Every prompt maps clack's cancel symbol to the `CANCEL` sentinel instead of
 * throwing, so a Ctrl-C mid-install is a value the engine can persist-and-exit
 * on, not an exception.
 */

/** The subset of `@clack/prompts` the UI uses — injectable for unit tests. */
export interface PromptBackend {
  intro: typeof clack.intro;
  outro: typeof clack.outro;
  note: typeof clack.note;
  log: typeof clack.log;
  select: typeof clack.select;
  multiselect: typeof clack.multiselect;
  confirm: typeof clack.confirm;
  text: typeof clack.text;
  password: typeof clack.password;
  spinner: typeof clack.spinner;
  isCancel: typeof clack.isCancel;
}

const realBackend: PromptBackend = {
  intro: clack.intro,
  outro: clack.outro,
  note: clack.note,
  log: clack.log,
  select: clack.select,
  multiselect: clack.multiselect,
  confirm: clack.confirm,
  text: clack.text,
  password: clack.password,
  spinner: clack.spinner,
  isCancel: clack.isCancel,
};

/** Map a clack result to `T | CANCEL`, never a thrown cancel. */
function unwrap<T>(value: T | symbol, isCancel: PromptBackend['isCancel']): Cancellable<T> {
  return isCancel(value) ? CANCEL : (value as T);
}

/** The real interactive UI. */
export function createClackUi(backend: PromptBackend = realBackend): Ui {
  const wrapValidate = (validate?: (v: string) => string | undefined) =>
    validate ? (v: string | undefined) => validate(v ?? '') : undefined;

  return {
    intro: (m) => backend.intro(m),
    outro: (m) => backend.outro(m),
    note: (m, title) => backend.note(m, title),
    info: (m) => backend.log.info(m),
    success: (m) => backend.log.success(m),
    warn: (m) => backend.log.warn(m),
    error: (m) => backend.log.error(m),
    async select(opts) {
      return unwrap(await backend.select(opts), backend.isCancel);
    },
    async multiselect(opts) {
      return unwrap(
        await backend.multiselect({ ...opts, required: opts.required ?? false }),
        backend.isCancel,
      );
    },
    async confirm(opts) {
      return unwrap(await backend.confirm(opts), backend.isCancel);
    },
    async text(opts) {
      return unwrap(await backend.text({ ...opts, validate: wrapValidate(opts.validate) }), backend.isCancel);
    },
    async password(opts) {
      return unwrap(await backend.password({ ...opts, validate: wrapValidate(opts.validate) }), backend.isCancel);
    },
    spinner(): SpinnerHandle {
      const s = backend.spinner();
      return {
        start: (m) => s.start(m),
        stop: (m) => s.stop(m),
        message: (m) => s.message(m),
      };
    },
  };
}

/**
 * Non-interactive UI for `--yes`, `CEZ_DRY_RUN`, and unit tests. Prompts resolve
 * to deterministic safe defaults (initial value, or the first option, or ""),
 * logs go to the console. It never touches stdin, so it can drive the engine
 * headless. Optional `answers` override defaults per-prompt-message.
 */
export function createAutoUi(answers: Record<string, unknown> = {}, sink: (m: string) => void = () => {}): Ui {
  const answer = <T>(message: string, fallback: T): T =>
    (message in answers ? (answers[message] as T) : fallback);
  return {
    intro: sink,
    outro: sink,
    note: (m) => sink(m),
    info: sink,
    success: sink,
    warn: sink,
    error: sink,
    async select(opts) {
      return answer(opts.message, opts.initialValue ?? opts.options[0]?.value) as never;
    },
    async multiselect(opts) {
      return answer(opts.message, [] as unknown[]) as never;
    },
    async confirm(opts) {
      return answer(opts.message, opts.initialValue ?? true);
    },
    async text(opts) {
      return answer(opts.message, opts.initialValue ?? opts.placeholder ?? '');
    },
    async password(opts) {
      return answer(opts.message, '');
    },
    spinner(): SpinnerHandle {
      return { start: (m) => m && sink(m), stop: (m) => m && sink(m), message: (m) => sink(m) };
    },
  };
}
