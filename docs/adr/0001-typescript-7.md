# Adopt TypeScript 7 (the native compiler)

We moved from TypeScript 5.6 to 7.0, the Go-native compiler rewrite. TypeScript 7 ships no
JavaScript compiler API — `require("typescript")` returns only `{ version, versionMajorMinor }`,
and `tsserver` is gone — which currently blocks typescript-eslint, ts-jest, and Volar-based
tooling. Cezar uses `tsc` purely as a compiler and typechecker: it has no eslint setup, no
programmatic consumer of the compiler API, and vite/vitest/tsx strip types with esbuild and
never load the `typescript` package. None of the blockers apply to us, so we took 7.0 directly
rather than parking on the 6.0 bridge release.

## Consequences

Two config changes are not obvious from reading the tsconfigs:

- **`"types": ["node"]` is now mandatory in `tsconfig.json`.** TypeScript 7 defaults `types` to
  `[]` instead of "every package under `@types`". Without it the build fails with `TS2591:
  Cannot find name 'process'` even though `@types/node` is installed.
- **`baseUrl` was removed from `web/app/tsconfig.json`.** TypeScript 7 removed the option
  (`TS5102`). `paths` now resolves relative to the tsconfig's own directory, so the existing
  `"@/*": ["./src/*"]` mapping kept working unchanged. The bundler-side alias is unaffected —
  it is declared explicitly in `web/app/vite.config.ts`, and the tsconfig `paths` entry only
  mirrors it for typechecking.

The binding constraint going forward: **we cannot add typescript-eslint (or any tool that
imports the compiler API) until TypeScript 7.1 ships the new API.** If we need such a tool
sooner, the sanctioned escape hatch is a side-by-side install — alias `typescript` to
`@typescript/typescript6` for API consumers while `tsc` stays on 7.x — rather than reverting.

`tsc` in 7.0 is fully capable for our use: JS + `.d.ts` + source-map emit under `NodeNext`,
project references, and `--build` all work. The compiler is a platform-specific Go binary
delivered through 20 optional dependencies; all of them are pinned in `package-lock.json`, so
`npm ci` on CI's `ubuntu-latest` resolves `linux-x64` correctly.

## Considered Options

- **Stay on 5.x.** Rejected: no upside beyond inertia, and the migration cost only grows.
- **Adopt 6.0 as a bridge first.** Microsoft recommends 5.x → 6.0 → 7.0 so deprecations surface
  as warnings before they become errors. Rejected as an unnecessary intermediate step here: the
  project is small enough that we could run the real 7.0 compiler and fix the two errors it
  actually reported. 6.0 would be worth it for a codebase too large to fix in one pass.
