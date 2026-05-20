export type { ProjectEnvSpec, RunEnv, ShellResult } from './run-env.js';
export { tailLines } from './run-env.js';
export { NativeShellEnv } from './native-shell-env.js';
export { DockerComposeEnv, spawnCapture, type ComposeCommand, type DockerComposeEnvOpts } from './docker-compose-env.js';
export { detectComposeFile, firstComposeService, COMPOSE_FILENAMES } from './compose-detect.js';
export { createRunEnv, resolveComposeCommand, type CreateRunEnvOpts } from './create-run-env.js';
