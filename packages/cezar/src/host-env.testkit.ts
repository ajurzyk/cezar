/**
 * Suite hermetyczna wobec środowiska, które ją odpaliło.
 *
 * Serwis czyta kilkadziesiąt przełączników `CEZ_*` (`src/workspace/config.ts`,
 * `src/paths.ts`, `src/core/*`), a testy neutralizują tylko te, o których pamiętał
 * autor danego pliku. Dowód, że to nie teoria — run 526bafac cezara, krok `baseline`:
 * kontener `cezar-staging` ma w env `CEZ_PROJECTS_DIR=/srv/dev`, więc
 * `projects-api.test.ts` dostawał '/srv/dev' tam, gdzie asercja żąda defaultu
 * '~/cezar/projects':
 *
 *     $ CEZ_PROJECTS_DIR=/srv/dev npx vitest run packages/cezar/src/server/projects-api.test.ts
 *     AssertionError: expected '/srv/dev' to be '~/cezar/projects'
 *      ❯ src/server/projects-api.test.ts:127:32   (i :152:32)
 *     Tests  2 failed | 37 passed (39)
 *
 * ...i bramka padała, zanim agent tknął kod. Ta sama przyczyna unieważnia pin
 * sandboxa `CEZ_HOME` w `vitest.setup.ts` (env kontenera ustawia go na prawdziwy
 * stan instancji, więc `if (!process.env.CEZ_HOME)` nigdy nie strzela) i podstawia
 * prawdziwy `CEZ_FORGEJO_TOKEN` testom czytającym token z env.
 *
 * Dlatego kasujemy CAŁĄ przestrzeń `CEZ_*`, a nie pojedyncze nazwy: test, który
 * potrzebuje przełącznika, ustawia go sam — i tak robią wszystkie.
 */
export function scrubInheritedCezEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env)
    .filter((key) => key.startsWith('CEZ_'))
    .sort();
  for (const key of removed) delete env[key];
  return removed;
}
