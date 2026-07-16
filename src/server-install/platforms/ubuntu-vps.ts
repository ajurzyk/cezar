import { CANCEL, PreflightError, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.js';
import { depCheckStep, owned, shquote, StepCancelled, sudoStep, verifyCommand } from '../steps.js';

/**
 * The `ubuntu-vps` strategy: stand up an authenticated, proxied cezar on a bare
 * Ubuntu/Debian VPS. cezar itself stays loopback-bound; nginx is the single
 * public surface (TLS + htpasswd identity) forwarding to 127.0.0.1:<port>.
 *
 * Phase 1 ships deps → nginx+htpasswd → identity-verify (and their `undo`s).
 * Phase 2 appends the optional SSL and autostart steps to `steps()`.
 */

const VHOST_AVAILABLE = '/etc/nginx/sites-available/cezar';
const VHOST_ENABLED = '/etc/nginx/sites-enabled/cezar';
const HTPASSWD = '/etc/cezar/htpasswd';

/** The nginx server block: auth_basic identity + SSE-safe proxy to loopback. */
export function nginxVhost(port: number): string {
  return `# Managed by cezar server-install — do not edit by hand.
server {
    listen 80;
    listen [::]:80;
    server_name _;

    auth_basic "cezar";
    auth_basic_user_file ${HTPASSWD};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # cezar streams SSE (run events). Never buffer it, or the cockpit goes mute.
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Connection '';
    }
}
`;
}

/** Build a privileged command that writes file content atomically (base64 → no quoting hell). */
function writeRootFileCmd(path: string, content: string, extra = ''): string {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  return `install -d -m 0755 ${shquote(dir)} && printf %s ${shquote(b64)} | base64 --decode > ${shquote(path)}${extra ? ` && ${extra}` : ''}`;
}

const nginxProxyStep: InstallStep = {
  id: 'nginx-proxy',
  title: 'Reverse proxy (nginx + htpasswd)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    const nginxOk = await verifyCommand(ctx, 'nginx', ['-v']);
    const vhostOk = await verifyCommand(ctx, 'test', ['-f', VHOST_ENABLED]);
    return nginxOk && vhostOk;
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // 1) nginx
    await sudoStep(ctx, {
      description: 'Install nginx (the public TLS + auth front for cezar).',
      command: 'apt-get update && apt-get install -y nginx',
      verify: (c) => verifyCommand(c, 'nginx', ['-v']),
    });

    // 2) identity credentials
    const user = await ctx.ui.text({
      message: 'Choose the login username for the cockpit',
      placeholder: 'ops',
      validate: (v) => (v.trim() ? undefined : 'username is required'),
    });
    if (user === CANCEL) throw new StepCancelled();
    const password = await ctx.ui.password({
      message: `Set a password for "${user}"`,
      validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
    });
    if (password === CANCEL) throw new StepCancelled();

    // 3) htpasswd file. The hash (not the plaintext) is embedded in the write
    //    command. openssl is always present on Ubuntu; apr1 is what nginx expects.
    const hash = ctx.dryRun
      ? '<dry-run-hash>'
      : (await ctx.runner.capture('openssl', ['passwd', '-apr1', password])).stdout.trim();
    await sudoStep(ctx, {
      description: 'Write the htpasswd identity file.',
      command: `install -d -m 0755 /etc/cezar && printf '%s:%s\\n' ${shquote(user)} ${shquote(hash)} > ${HTPASSWD} && chmod 0644 ${HTPASSWD}`,
      verify: (c) => verifyCommand(c, 'test', ['-f', HTPASSWD]),
    });

    // 4) vhost + enable + reload
    await sudoStep(ctx, {
      description: 'Write the cezar nginx site and reload.',
      command:
        writeRootFileCmd(VHOST_AVAILABLE, nginxVhost(ctx.state.primaryPort)) +
        ` && ln -sf ${VHOST_AVAILABLE} ${VHOST_ENABLED} && rm -f /etc/nginx/sites-enabled/default && nginx -t && systemctl reload nginx`,
      verify: (c) => verifyCommand(c, 'test', ['-f', VHOST_ENABLED]),
    });

    return {
      artifacts: [
        owned('file', { path: VHOST_AVAILABLE }),
        owned('symlink', { path: VHOST_ENABLED }),
        owned('htpasswd', { path: HTPASSWD, name: user }),
      ],
    };
  },
  async undo(ctx, created) {
    const paths = (created?.artifacts ?? [])
      .filter((a) => a.kind === 'owned' && a.path)
      .map((a) => a.path as string);
    if (paths.length === 0) return;
    await sudoStep(ctx, {
      description: 'Remove the cezar nginx site + htpasswd and reload nginx.',
      command: `rm -f ${paths.map(shquote).join(' ')} && (nginx -t && systemctl reload nginx || true)`,
      verify: (c) => verifyCommand(c, 'sh', ['-c', `! test -f ${VHOST_ENABLED}`]),
    });
  },
};

const identityStep: InstallStep = {
  id: 'identity',
  title: 'Identity check (proxy challenges anonymous requests)',
  async check() {
    return false; // always re-verify; it creates nothing
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would verify an anonymous request to the proxy returns 401.');
      return { artifacts: [] };
    }
    const challenged = await verifyCommand(
      ctx,
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1/'],
      (r) => r.stdout.trim() === '401',
    );
    if (challenged) {
      ctx.ui.success('The proxy challenges unauthenticated requests (401). Identity is enforced.');
    } else {
      ctx.ui.warn('Could not confirm a 401 challenge — verify nginx is running and the htpasswd file is set.');
    }
    return { artifacts: [] };
  },
  async undo() {
    // nothing created
  },
};

export const ubuntuVps: PlatformStrategy = {
  id: 'ubuntu-vps',
  label: 'Ubuntu/Debian VPS',
  async preflight(ctx: InstallContext) {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — skipping OS/privilege preflight.');
      return;
    }
    const uname = await ctx.runner.capture('uname', ['-s']);
    if (!uname.stdout.includes('Linux')) {
      throw new PreflightError('ubuntu-vps requires Linux. On macOS use --platform macosx-ngrok.');
    }
    if ((await ctx.runner.capture('apt-get', ['--version'])).code !== 0) {
      throw new PreflightError('ubuntu-vps requires apt (Debian/Ubuntu).');
    }
    if ((await ctx.runner.capture('id', ['-u'])).stdout.trim() === '0') {
      throw new PreflightError('run server-install as a normal sudo-capable user, not root.');
    }
  },
  steps(): InstallStep[] {
    // Phase 1: deps → proxy → identity. Phase 2 inserts ssl + autostart before identity.
    return [depCheckStep(), nginxProxyStep, identityStep];
  },
};
