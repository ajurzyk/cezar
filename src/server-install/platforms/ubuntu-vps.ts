import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { CANCEL, PreflightError, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.js';
import { depCheckStep, owned, shared, shquote, StepAborted, StepCancelled, StepSkipped, sudoStep, verifyCommand } from '../steps.js';

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
    // The non-interactive UI (`--yes`) cannot invent a password and does not run
    // validators — refuse rather than write an empty-password htpasswd (a public
    // cockpit anyone can open). A real install must set a password interactively.
    if (!ctx.dryRun && String(password).length < 6) {
      throw new StepAborted('a cockpit password (≥6 chars) is required — run server-install without --yes to set one');
    }

    // 3) htpasswd file. The hash (not the plaintext) is embedded in the write
    //    command; the plaintext is fed to openssl via stdin so it never appears
    //    in the process argv (visible to other users via `ps`). apr1 is what
    //    nginx's auth_basic expects.
    const hash = ctx.dryRun
      ? '<dry-run-hash>'
      : (await ctx.runner.capture('openssl', ['passwd', '-apr1', '-stdin'], { input: `${String(password)}\n` })).stdout.trim();
    await sudoStep(ctx, {
      description: 'Write the htpasswd identity file.',
      command: `install -d -m 0755 /etc/cezar && printf '%s:%s\\n' ${shquote(user)} ${shquote(hash)} > ${HTPASSWD} && chmod 0640 ${HTPASSWD}`,
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
  async undo(ctx) {
    // Remove the *known* cezar-owned paths (constants), so uninstall works even
    // if server.json was lost and the step was re-recorded with created=null.
    // Also restore the default site symlink the run removed, and drop /etc/cezar.
    await sudoStep(ctx, {
      description: 'Remove the cezar nginx site + htpasswd, restore the default site, reload nginx.',
      command:
        `rm -f ${VHOST_ENABLED} ${VHOST_AVAILABLE} ${HTPASSWD}` +
        ` && { [ -e /etc/nginx/sites-available/default ] && ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default || true; }` +
        ` && { rmdir /etc/cezar 2>/dev/null || true; }` +
        ` && { nginx -t && systemctl reload nginx || true; }`,
      verify: (c) => verifyCommand(c, 'sh', ['-c', `! test -f ${VHOST_ENABLED}`]),
    });
  },
};

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const sslStep: InstallStep = {
  id: 'ssl',
  title: 'Domain + SSL (Let’s Encrypt)',
  optional: true,
  async check() {
    return false; // optional — the engine gates it with a confirm; certbot is idempotent
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    const domain = await ctx.ui.text({
      message: 'Domain pointing at this server (an A/AAAA record must resolve here)',
      placeholder: 'cezar.example.com',
      validate: (v) => (HOSTNAME_RE.test(v.trim()) ? undefined : 'enter a valid domain'),
    });
    if (domain === CANCEL) throw new StepCancelled();
    const email = await ctx.ui.text({
      message: 'Email for Let’s Encrypt renewal notices',
      placeholder: 'you@example.com',
      validate: (v) => (EMAIL_RE.test(v.trim()) ? undefined : 'enter a valid email'),
    });
    if (email === CANCEL) throw new StepCancelled();

    await sudoStep(ctx, {
      description: 'Install certbot + its nginx plugin.',
      command: 'apt-get install -y certbot python3-certbot-nginx',
      verify: (c) => verifyCommand(c, 'certbot', ['--version']),
    });

    if (ctx.dryRun) {
      ctx.ui.info(`DRY RUN — would run: sudo certbot --nginx -d ${domain} --redirect`);
    } else {
      // certbot can legitimately fail on external state (DNS not pointed, LE
      // rate limit), so it does not go through sudoStep's redo loop — we let the
      // operator retry or skip and finish by hand later.
      for (;;) {
        const code = await ctx.runner.interactive('sudo', [
          'certbot', '--nginx', '-d', String(domain), '--non-interactive', '--agree-tos', '-m', String(email), '--redirect',
        ]);
        if (code === 0) break;
        ctx.ui.warn(
          'certbot did not complete. Usual causes: the domain’s DNS is not pointed at this server yet, or a Let’s Encrypt rate limit.',
        );
        const choice = await ctx.ui.select<'retry' | 'skip'>({
          message: 'What now?',
          options: [
            { value: 'retry', label: 'Retry certbot' },
            { value: 'skip', label: 'Skip SSL — I’ll run certbot later', hint: `sudo certbot --nginx -d ${domain}` },
          ],
          initialValue: 'skip',
        });
        if (choice === CANCEL || choice === 'skip') throw new StepSkipped('certbot did not complete');
      }
    }

    ctx.state.publicUrl = `https://${String(domain)}`;
    // The cert + its auto-renewal timer are `shared`: uninstall lists them, it
    // does not delete them (removing a cert can break other vhosts).
    return {
      artifacts: [shared('cert', { name: String(domain), removeHint: `sudo certbot delete --cert-name ${String(domain)}` })],
    };
  },
  async undo(ctx, created) {
    const cert = (created?.artifacts ?? []).find((a) => a.type === 'cert');
    if (cert) {
      ctx.ui.note(
        `The TLS certificate for ${cert.name ?? 'your domain'} and its auto-renewal timer were left in place.\nRemove them yourself if you want them gone:\n${cert.removeHint ?? ''}`,
        'SSL',
      );
    }
    // The vhost (with certbot’s edits) is removed by the nginx-proxy step’s undo.
  },
};

const UNIT_NAME = 'cezar.service';

/**
 * systemd unit that runs cezar loopback-bound with CEZ_REMOTE=1. `execStart`
 * must be an ABSOLUTE command — systemd runs units with a minimal PATH
 * (/usr/bin:/bin), so a bare `cezar` (installed via nvm/npm-prefix/npx) would
 * not resolve and the unit would crash-loop.
 */
export function systemdUnit(repoRoot: string, port: number, scope: 'user' | 'system', execStart: string): string {
  const userLine = scope === 'system' ? `User=${userInfo().username}\n` : '';
  const installTarget = scope === 'system' ? 'multi-user.target' : 'default.target';
  return `# Managed by cezar server-install — do not edit by hand.
[Unit]
Description=cezar cockpit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${userLine}WorkingDirectory=${repoRoot}
Environment=CEZ_REMOTE=1
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=${execStart} serve --no-open --port ${port}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=${installTarget}
`;
}

/** Absolute path to the cezar CLI on this box, or a bare fallback in dry-run. */
async function resolveCezarBin(ctx: InstallContext): Promise<string> {
  if (ctx.dryRun) return 'cezar';
  const found = (await ctx.runner.capture('bash', ['-lc', 'command -v cezar'])).stdout.trim();
  return found || 'cezar';
}

const autostartStep: InstallStep = {
  id: 'autostart',
  title: 'Autostart on boot (systemd)',
  optional: true,
  async check() {
    return false; // optional — engine gates with a confirm
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    const execStart = await resolveCezarBin(ctx);
    // Prefer a rootless `systemd --user` service + linger; fall back to a system
    // unit (via sudoStep) when the user bus is not reachable. `show-environment`
    // exits 0 iff the user manager is up — on a headless SSH box with no session
    // it fails (exit 1, not 127), which the old `!== 127` test misread as "up".
    const userBus = ctx.dryRun ? true : (await ctx.runner.capture('systemctl', ['--user', 'show-environment'])).code === 0;

    if (userBus) {
      const unitPath = join(homedir(), '.config', 'systemd', 'user', UNIT_NAME);
      if (ctx.dryRun) {
        ctx.ui.info(`DRY RUN — would write ${unitPath} and enable it (systemctl --user enable --now cezar).`);
      } else {
        mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
        writeFileSync(unitPath, systemdUnit(ctx.repoRoot, ctx.state.primaryPort, 'user', execStart), 'utf8');
        await ctx.runner.interactive('systemctl', ['--user', 'daemon-reload']);
        await ctx.runner.interactive('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
        if ((await ctx.runner.capture('systemctl', ['--user', 'is-enabled', UNIT_NAME])).code !== 0) {
          ctx.ui.warn('The user service did not enable cleanly — check `systemctl --user status cezar`.');
        }
      }
      // Linger lets the user service survive logout / start at boot — usually needs root.
      await sudoStep(ctx, {
        description: 'Enable linger so the cockpit starts at boot without a login session.',
        command: `loginctl enable-linger ${shquote(userInfo().username)}`,
        verify: (c) =>
          verifyCommand(c, 'loginctl', ['show-user', userInfo().username, '-p', 'Linger'], (r) =>
            r.stdout.includes('Linger=yes'),
          ),
      });
      return { artifacts: [owned('service', { name: UNIT_NAME, scope: 'user', path: unitPath })] };
    }

    // System unit fallback.
    const b64 = Buffer.from(systemdUnit(ctx.repoRoot, ctx.state.primaryPort, 'system', execStart), 'utf8').toString('base64');
    await sudoStep(ctx, {
      description: 'Install the cezar systemd unit and enable it at boot.',
      command: `printf %s ${shquote(b64)} | base64 --decode > /etc/systemd/system/${UNIT_NAME} && systemctl daemon-reload && systemctl enable --now ${UNIT_NAME}`,
      verify: (c) => verifyCommand(c, 'systemctl', ['is-enabled', UNIT_NAME]),
    });
    return { artifacts: [owned('service', { name: UNIT_NAME, scope: 'system', path: `/etc/systemd/system/${UNIT_NAME}` })] };
  },
  async undo(ctx, created) {
    const svc = (created?.artifacts ?? []).find((a) => a.type === 'service');
    if (!svc) return;
    if (svc.scope === 'user') {
      if (!ctx.dryRun) {
        await ctx.runner.interactive('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
        if (svc.path) rmSync(svc.path, { force: true });
        await ctx.runner.interactive('systemctl', ['--user', 'daemon-reload']);
      } else {
        ctx.ui.info('DRY RUN — would disable and remove the user service.');
      }
      return;
    }
    await sudoStep(ctx, {
      description: 'Disable and remove the cezar systemd unit.',
      command: `systemctl disable --now ${UNIT_NAME}; rm -f /etc/systemd/system/${UNIT_NAME} && systemctl daemon-reload`,
      verify: (c) => verifyCommand(c, 'sh', ['-c', `! systemctl is-enabled ${UNIT_NAME}`]),
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
    // deps → proxy → (optional) ssl → (optional) autostart → identity.
    return [depCheckStep(), nginxProxyStep, sslStep, autostartStep, identityStep];
  },
};
