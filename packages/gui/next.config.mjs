/** @type {import('next').NextConfig} */
const nextConfig = {
  // `standalone` produces a self-contained server under `.next/standalone/`
  // with all traced runtime deps — what the Docker runtime stage copies.
  // Falls back to a no-op when `next start` is used directly.
  output: 'standalone',
  // Workspace root for file-tracing in the monorepo; without this Next
  // warns and may pick the wrong root inside Docker.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  serverExternalPackages: [
    '@cezar/core',
    '@anthropic-ai/sdk',
    '@anthropic-ai/claude-agent-sdk',
    '@octokit/rest',
    'cosmiconfig',
  ],
  experimental: {
    typedRoutes: false,
  },
};

export default nextConfig;
