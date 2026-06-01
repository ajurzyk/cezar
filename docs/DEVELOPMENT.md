# Development

Local development setup, tech stack, and extension points.

- [Commands](#commands)
- [Tech stack](#tech-stack)
- [Adding a new Action](#adding-a-new-action)
- [Adding a new effect](#adding-a-new-effect)

---

## Commands

```bash
yarn install
yarn build                                   # topological monorepo build
yarn test                                    # all workspaces
yarn typecheck
yarn lint

# per-workspace
yarn workspace @cezar/core   run test
yarn workspace @cezar/core   run build
yarn workspace cezar         run build
yarn workspace @cezar/runner run build
yarn workspace @cezar/gui    run build
yarn workspace @cezar/gui    run dev         # Next.js dev server

# single test file
cd packages/core && npx vitest run tests/store/store.test.ts

# local Supabase (docker compose stack in infra/supabase/)
yarn db:start                                # up -d (db + kong + Realtime)
yarn db:stop                                 # down
yarn db:reset                                # down -v && up -d (wipes data)
yarn db:logs                                 # follow logs
yarn db:psql                                 # psql -U postgres -d postgres
```

---

## Tech stack

- **TypeScript 5.x** strict, ES2022, NodeNext/ESM (`.js` on relative imports
  in core).
- **Node 20+** — native fetch, ESM, `node:util.parseArgs`.
- **Commander.js** + **@inquirer/prompts** for the CLI.
- **@octokit/rest** + **@octokit/auth-app** for GitHub.
- **@anthropic-ai/sdk** (streaming) + **@anthropic-ai/claude-agent-sdk**.
- **Zod** for config and LLM-response validation.
- **vitest** for tests.
- **Next.js 15** + **Supabase** + **Tailwind** for the GUI.

---

## Adding a new Action

Built-in catalog (ships with `@cezar/core`):

1. Append an entry to [`packages/core/src/actions-v2/default-actions.ts`](../packages/core/src/actions-v2/default-actions.ts).
2. Add the matching skill playbook to [`packages/core/skills/`](../packages/core/skills/).
3. Mirror the row in [`packages/gui/supabase/migrations/0014_seed_default_actions.sql`](../packages/gui/supabase/migrations/0014_seed_default_actions.sql)
   so the SaaS catalog matches. (A future change will seed-from-TS to remove
   the duplication.)

Workspace-scoped Action (no code change):

- Use **Actions → New** in the GUI, or override an existing built-in via
  **Actions → `<name>` → Override**. The clone is fully editable.

---

## Adding a new effect

1. Append an `EffectDef` to [`packages/core/src/actions-v2/effects.ts`](../packages/core/src/actions-v2/effects.ts)
   with a Zod schema for its input and an `execute(args, ctx)` impl.
2. Register it in `EFFECT_REGISTRY`. The runner and the Anthropic-tools
   generator pick it up automatically — no other plumbing.
