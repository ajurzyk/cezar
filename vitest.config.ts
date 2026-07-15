import { defineConfig } from 'vitest/config'

// Two runtimes, one `npm test`: the server is Node ESM (NodeNext, `.js` relative imports),
// the cockpit app is DOM code bundled by Vite. They cannot share an environment, so each
// gets its own vitest project. The `web` project inherits the real build config
// (React plugin, `@` alias) from web/app/vitest.config.ts so tests resolve exactly as the
// bundle does.
export default defineConfig({
  test: {
    // The suites are still being grown; a project that currently matches no file must not
    // fail the validation gate. Root-level only — vitest rejects this inside a project.
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'server',
          root: import.meta.dirname,
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      './web/app/vitest.config.ts',
    ],
  },
})
