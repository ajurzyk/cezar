/**
 * Reusable `autofix.projectEnv` presets the Settings form can apply with one
 * click. Each preset describes how to install / build / test a specific kind of
 * target repo, plus an optional dev server the autofix agent can curl-probe.
 *
 * Adding one: type it to mirror the form's projectEnv field layout (kind,
 * install/build/test, gateOn*, compose.*, envVars, devServer.*) so the apply
 * logic in `settings-form.tsx` can map it 1:1.
 */
export interface ProjectEnvPreset {
  id: string;
  label: string;
  description: string;
  values: {
    kind: 'auto' | 'native' | 'compose';
    install: string;
    build: string;
    test: string;
    gateOnInstall: boolean;
    gateOnBuild: boolean;
    gateOnTest: boolean;
    compose: { file: string; service: string; workdir: string };
    envVars: Record<string, string>;
    devServer: {
      enabled: boolean;
      command: string;
      port: number;
      readyPath: string;
      readyTimeoutSec: number;
    };
  };
}

export const PROJECT_ENV_PRESETS: ProjectEnvPreset[] = [
  {
    id: 'open-mercato',
    label: 'open-mercato — yarn dev:ephemeral + integration tests',
    description:
      "Drives open-mercato's built-in ephemeral runtime: `yarn dev:ephemeral` (Postgres + Next.js dev) for live curl probing, `yarn test:integration:ephemeral` for the gated test step. Requires a self-hosted runner with Docker and Node 24. Pins the dev port to 5050 via DEV_EPHEMERAL_PREFERRED_PORT.",
    values: {
      kind: 'native',
      install: 'yarn install --immutable',
      build: '',
      test: 'yarn test:integration:ephemeral',
      gateOnInstall: true,
      gateOnBuild: false,
      gateOnTest: true,
      compose: { file: '', service: '', workdir: '/app' },
      envVars: {
        DEV_EPHEMERAL_PREFERRED_PORT: '5050',
        CI: 'true',
      },
      devServer: {
        enabled: true,
        command: 'yarn dev:ephemeral --classic',
        port: 5050,
        readyPath: '/backend/login',
        readyTimeoutSec: 180,
      },
    },
  },
];
