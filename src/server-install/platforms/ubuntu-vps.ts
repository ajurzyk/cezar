import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { CANCEL, PreflightError, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.js';
import { depCheckStep, generatePassword, owned, shared, shquote, StepAborted, StepCancelled, StepSkipped, sudoStep, verifyCommand } from '../steps.js';

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

/** Best-effort current OS username, suggested as the default cockpit login. */
function currentUsername(): string {
  try {
    return userInfo().username || 'ops';
  } catch {
    return 'ops';
  }
}

/** True when ufw is installed and reports `Status: active`. */
async function ufwIsActive(ctx: InstallContext): Promise<boolean> {
  const r = await ctx.runner.capture('sh', ['-c', 'command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null || true']);
  return /Status:\s*active/.test(r.stdout);
}

/** The HTTP status curl saw for a request ("000" = could not connect / no response). */
async function curlCode(ctx: InstallContext, args: string[], opts?: { input?: string }): Promise<string> {
  const r = await ctx.runner.capture('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', ...args], opts);
  return r.stdout.trim() || '000';
}

/** True once cezar answers on 127.0.0.1:<port> (any HTTP status = the process is up). */
async function isCezarUp(ctx: InstallContext, port: number): Promise<boolean> {
  const code = await curlCode(ctx, [`http://127.0.0.1:${port}/`]);
  return code !== '000';
}

/** Poll the loopback upstream until cezar responds or the attempts run out. */
async function waitForCezar(ctx: InstallContext, port: number, attempts = 15): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await isCezarUp(ctx, port)) return true;
    // `sleep 1` via the runner keeps this testable (no real timers in unit tests).
    if (i < attempts - 1) await ctx.runner.capture('sh', ['-c', 'sleep 1']);
  }
  return false;
}

/**
 * After a service is enabled, wait for cezar to actually answer on the loopback
 * port. A running unit that crash-loops (bad WorkingDirectory, missing build)
 * would otherwise leave nginx proxying to nothing (502) while the installer
 * claims success. On failure, point the operator at the service logs.
 */
async function confirmCezarRunning(ctx: InstallContext, statusCmd: string, logsCmd: string): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would wait for cezar on 127.0.0.1:${ctx.state.primaryPort}.`);
    return;
  }
  const sp = ctx.ui.spinner();
  sp.start(`Waiting for cezar to start on 127.0.0.1:${ctx.state.primaryPort}…`);
  const up = await waitForCezar(ctx, ctx.state.primaryPort);
  sp.stop(up ? 'cezar is running.' : 'cezar did not come up.');
  if (!up) {
    ctx.ui.warn(
      `cezar is not answering on 127.0.0.1:${ctx.state.primaryPort} yet — nginx will return 502 until it is.\n` +
        `Check the service:\n  • ${statusCmd}\n  • ${logsCmd}\n` +
        'Common causes: the WorkingDirectory has no built cezar, or the port is wrong.',
    );
  }
}

/**
 * The nginx server block: auth_basic identity + SSE-safe proxy to loopback.
 * `serverName` defaults to the catch-all `_`; the SSL step rewrites it to the
 * real domain so the `certbot --nginx` plugin can find this vhost to edit.
 */
export function nginxVhost(port: number, serverName = '_'): string {
  return `# Managed by cezar server-install — do not edit by hand.
server {
    listen 80;
    listen [::]:80;
    server_name ${serverName};

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

/**
 * A sudoStep that writes a root-owned file. The command carries the content as
 * base64 (so quoting/newlines survive a copy-paste), which is unreadable — so we
 * always show the DECODED file content in a note first, so the operator can see
 * exactly what will land on disk and knows the base64 is not doing anything
 * hidden.
 */
function writeFileStep(
  ctx: InstallContext,
  opts: {
    description: string;
    path: string;
    content: string;
    /** Extra shell appended after the write (` && …`). */
    extra?: string;
    verify: (c: InstallContext) => Promise<boolean>;
  },
): Promise<void> {
  return sudoStep(ctx, {
    description: opts.description,
    note: `This writes ${opts.path} with exactly this content:\n\n${opts.content}`,
    command: writeRootFileCmd(opts.path, opts.content, opts.extra),
    verify: opts.verify,
  });
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

    // 2) identity credentials. This is the HTTP Basic-Auth login nginx will
    //    challenge for over HTTPS — i.e. what you type in the browser to reach
    //    the cockpit. Suggest the current OS user as a sensible default.
    const suggestedUser = currentUsername();
    const user = await ctx.ui.text({
      message: 'Cockpit login username (HTTPS Basic-Auth — you type this in the browser to reach the cockpit)',
      placeholder: suggestedUser,
      initialValue: suggestedUser,
      validate: (v) => (v.trim() ? undefined : 'username is required'),
    });
    if (user === CANCEL) throw new StepCancelled();

    // Set the cockpit password. Interactive operators may auto-generate a strong
    // one (shown once) or type their own. Under `--yes` (no human) there is no
    // menu — the password comes straight from the UI, and the length backstop
    // below refuses an empty one rather than standing up an open cockpit (H1).
    let password: string;
    if (ctx.assumeYes) {
      const typed = await ctx.ui.password({
        message: `Set the HTTPS cockpit password for "${user}"`,
        validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
      });
      if (typed === CANCEL) throw new StepCancelled();
      password = String(typed);
    } else {
      const how = await ctx.ui.select<'generate' | 'manual'>({
        message: `Cockpit password for "${user}" (used with the username to log in over HTTPS)`,
        options: [
          { value: 'generate', label: 'Generate a strong password for me', hint: 'shown once — save it now' },
          { value: 'manual', label: 'Type my own password' },
        ],
        initialValue: 'generate',
      });
      if (how === CANCEL) throw new StepCancelled();
      if (how === 'generate') {
        password = generatePassword();
        ctx.ui.note(
          `Username: ${user}\nPassword: ${password}\n\nSave these now — this is your cockpit login. cezar stores only a hash; the plaintext is not written anywhere and cannot be recovered.`,
          'Generated cockpit credentials',
        );
      } else {
        const typed = await ctx.ui.password({
          message: `Set the HTTPS cockpit password for "${user}"`,
          validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
        });
        if (typed === CANCEL) throw new StepCancelled();
        password = String(typed);
      }
    }
    // The non-interactive UI (`--yes`) cannot invent a password and does not run
    // validators — refuse rather than write an empty-password htpasswd (a public
    // cockpit anyone can open). A real install must set a password interactively.
    if (!ctx.dryRun && String(password).length < 6) {
      throw new StepAborted('a cockpit password (≥6 chars) is required — run server-install without --yes to set one');
    }
    // Keep the credentials in memory (never persisted) so the final verify step
    // can prove an authenticated request actually reaches cezar over the proxy.
    ctx.prefs.cockpit = { user, password };

    // 3) htpasswd file. The hash (not the plaintext) is embedded in the write
    //    command; the plaintext is fed to openssl via stdin so it never appears
    //    in the process argv (visible to other users via `ps`). apr1 is what
    //    nginx's auth_basic expects.
    let hash = '<dry-run-hash>';
    if (!ctx.dryRun) {
      const out = await ctx.runner.capture('openssl', ['passwd', '-apr1', '-stdin'], { input: `${String(password)}\n` });
      hash = out.stdout.trim();
      if (out.code !== 0 || !hash) throw new StepAborted('failed to hash the password (openssl) — cannot write htpasswd');
    }
    // nginx workers run as www-data and read auth_basic_user_file per request,
    // so the file must be group-readable by www-data — 0640 root:root would make
    // every request 500. 0640 root:www-data: readable by nginx, not by others.
    await sudoStep(ctx, {
      description: 'Write the htpasswd identity file that nginx checks on every request.',
      note: `${HTPASSWD}\n\n${user}:<apr1 hash of your password>`,
      command: `install -d -m 0755 /etc/cezar && printf '%s:%s\\n' ${shquote(user)} ${shquote(hash)} > ${HTPASSWD} && chown root:www-data ${HTPASSWD} && chmod 0640 ${HTPASSWD}`,
      verify: (c) => verifyCommand(c, 'test', ['-f', HTPASSWD]),
    });

    // Record whether the distro's default site was enabled *before* we disable
    // it, so undo only re-enables it if we were the one who removed it.
    const defaultWasEnabled = await verifyCommand(ctx, 'test', ['-L', '/etc/nginx/sites-enabled/default']);

    // 4) vhost + enable + reload
    const vhost = nginxVhost(ctx.state.primaryPort);
    await writeFileStep(ctx, {
      description: 'Write the cezar nginx site, enable it, and reload nginx.',
      path: VHOST_AVAILABLE,
      content: vhost,
      extra: `ln -sf ${VHOST_AVAILABLE} ${VHOST_ENABLED} && rm -f /etc/nginx/sites-enabled/default && nginx -t && systemctl reload nginx`,
      verify: (c) => verifyCommand(c, 'test', ['-f', VHOST_ENABLED]),
    });

    // 5) firewall: if ufw is active, the cockpit is unreachable until 80/443 are
    //    allowed — a common "installed fine but nothing loads" cause. This is a
    //    best-effort sub-step of the (required) proxy step: skipping it must not
    //    fail the whole install, so a StepSkipped is swallowed here.
    if (!ctx.dryRun && (await ufwIsActive(ctx))) {
      try {
        await sudoStep(ctx, {
          description: 'ufw is active — allow HTTP/HTTPS so the cockpit is reachable.',
          command: `ufw allow 'Nginx Full'`,
          skippable: true,
          skipHint: 'open ports 80 and 443 yourself, or via a cloud firewall',
          verify: (c) => verifyCommand(c, 'sh', ['-c', "ufw status | grep -q 'Nginx Full'"]),
        });
      } catch (err) {
        if (!(err instanceof StepSkipped)) throw err;
        ctx.ui.warn('Firewall left unchanged — make sure ports 80 and 443 are reachable, or the cockpit will not load.');
      }
    }

    const artifacts: StepArtifact[] = [
      owned('file', { path: VHOST_AVAILABLE }),
      owned('symlink', { path: VHOST_ENABLED }),
      owned('htpasswd', { path: HTPASSWD, name: user }),
    ];
    if (defaultWasEnabled) artifacts.push(owned('nginx-default', { path: '/etc/nginx/sites-enabled/default' }));
    return { artifacts };
  },
  async undo(ctx, created) {
    // Remove the *known* cezar-owned paths (constants), so uninstall works even
    // if server.json was lost and the step was re-recorded with created=null.
    // Only re-enable the default site if the run recorded that it disabled it.
    const restoreDefault = (created?.artifacts ?? []).some((a) => a.type === 'nginx-default');
    const restoreClause = restoreDefault
      ? ` && { [ -e /etc/nginx/sites-available/default ] && ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default || true; }`
      : '';
    await sudoStep(ctx, {
      description: 'Remove the cezar nginx site + htpasswd, reload nginx.',
      command:
        `rm -f ${VHOST_ENABLED} ${VHOST_AVAILABLE} ${HTPASSWD}` +
        restoreClause +
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

    // Point the nginx site's server_name at the domain BEFORE running certbot.
    // The `certbot --nginx` plugin locates the vhost by matching `server_name`
    // against `-d <domain>`; with the catch-all `server_name _;` it fails with
    // "Unable to find a VirtualHost". Doing this first also means that if the
    // operator skips certbot now, a later manual `certbot --nginx -d <domain>`
    // just works — no "could not find a matching server" (issue #8).
    const domainVhost = nginxVhost(ctx.state.primaryPort, String(domain).trim());
    await writeFileStep(ctx, {
      description: `Point the nginx site at ${String(domain).trim()} so certbot can configure TLS for it.`,
      path: VHOST_AVAILABLE,
      content: domainVhost,
      extra: `ln -sf ${VHOST_AVAILABLE} ${VHOST_ENABLED} && nginx -t && systemctl reload nginx`,
      verify: (c) =>
        verifyCommand(c, 'sh', ['-c', `grep -qF ${shquote(`server_name ${String(domain).trim()}`)} ${VHOST_AVAILABLE}`]),
    });

    // certbot can legitimately fail on external state (DNS not pointed yet, LE
    // rate limit). Route it through sudoStep so it honors the sudo/delegate
    // choice (issue #7) and offers Skip on repeated failure (issue #8) — on
    // skip, nginx is already configured for a later manual certbot run.
    await sudoStep(ctx, {
      description: `Obtain and install a Let’s Encrypt certificate for ${String(domain).trim()} (adds HTTPS + redirect).`,
      command: `certbot --nginx -d ${shquote(String(domain).trim())} --non-interactive --agree-tos -m ${shquote(String(email).trim())} --redirect`,
      skippable: true,
      skipHint: `run later: sudo certbot --nginx -d ${String(domain).trim()}`,
      // Verify via the nginx vhost, NOT /etc/letsencrypt/live — that dir is 0700
      // root, so a non-root `test -d` (the operator ran certbot themselves) fails
      // with permission-denied and reports a false failure even when the cert was
      // issued. certbot --nginx writes `ssl_certificate …` into the vhost, which
      // is world-readable, so grepping it works without root.
      verify: (c) => verifyCommand(c, 'sh', ['-c', `grep -qs ssl_certificate ${VHOST_AVAILABLE} ${VHOST_ENABLED}`]),
    });

    ctx.state.publicUrl = `https://${String(domain).trim()}`;
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
 * systemd unit that runs cezar loopback-bound with CEZ_REMOTE=1.
 *
 * `execStart` must be an ABSOLUTE command — systemd resolves the ExecStart
 * executable against its OWN compiled-in PATH (/usr/local/bin:/usr/bin:…), NOT
 * the unit's `Environment=PATH`, so a bare `cezar` gives status=203/EXEC
 * ("Unable to locate executable"). `resolveExecStart` therefore returns an
 * absolute `"<node> <entry.js>"`. We still set `Environment=PATH` (with the
 * installer's node dir) for any child process the app spawns.
 */
export function systemdUnit(repoRoot: string, port: number, scope: 'user' | 'system', execStart: string): string {
  const userLine = scope === 'system' ? `User=${userInfo().username}\n` : '';
  const installTarget = scope === 'system' ? 'multi-user.target' : 'default.target';
  const pathDirs = [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin']
    .filter((d, i, a) => d && d !== '.' && a.indexOf(d) === i);
  return `# Managed by cezar server-install — do not edit by hand.
[Unit]
Description=cezar cockpit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${userLine}WorkingDirectory=${repoRoot}
Environment=CEZ_REMOTE=1
Environment=PATH=${pathDirs.join(':')}
ExecStart=${execStart} serve --no-open --port ${port}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=${installTarget}
`;
}

/**
 * The absolute ExecStart command for the service: `"<node> <cezar entry.js>"`.
 * Both parts are absolute so systemd never has to resolve a name off PATH.
 *
 *  1. Preferred — the repo's own built entry (`<repoRoot>/dist/index.js`): the
 *     installer is run from a checkout, so this is present and authoritative.
 *  2. Else a globally-installed `cezar` bin (resolved via a login shell so
 *     nvm/npm-prefix installs are found), run through the same node.
 *  3. Else fall back to the repo entry path and warn to build it first.
 */
async function resolveExecStart(ctx: InstallContext): Promise<string> {
  const node = process.execPath; // absolute node running this installer
  const entry = join(ctx.repoRoot, 'dist', 'index.js');
  if (ctx.dryRun) return `${node} ${entry}`;
  if (existsSync(entry)) return `${node} ${entry}`;
  const out = (await ctx.runner.capture('bash', ['-lc', 'command -v cezar'])).stdout.trim();
  const bin = out.split('\n').map((s) => s.trim()).filter(Boolean).pop();
  if (bin) return `${node} ${bin}`;
  ctx.ui.warn(
    `No built cezar found to run: ${entry} is missing and no global 'cezar' is installed.\n` +
      `Build it first (in ${ctx.repoRoot}: npm install && npm run build), then re-run with --reconfigure autostart.`,
  );
  return `${node} ${entry}`;
}

const autostartStep: InstallStep = {
  id: 'autostart',
  // Required: after install the cockpit must actually be serving, so cezar runs
  // as a systemd service — started now AND enabled on boot. (id kept as
  // `autostart` for state compatibility.)
  title: 'Run cezar as a service (systemd — starts now + on boot)',
  async check() {
    return false; // always (re)assert the service is installed and running
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    const execStart = await resolveExecStart(ctx);
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
      await confirmCezarRunning(ctx, 'systemctl --user status cezar', 'journalctl --user -u cezar -n 50 --no-pager');
      return { artifacts: [owned('service', { name: UNIT_NAME, scope: 'user', path: unitPath })] };
    }

    // System unit fallback.
    await writeFileStep(ctx, {
      description: 'Install the cezar systemd unit, start it now, and enable it at boot.',
      path: `/etc/systemd/system/${UNIT_NAME}`,
      content: systemdUnit(ctx.repoRoot, ctx.state.primaryPort, 'system', execStart),
      extra: `systemctl daemon-reload && systemctl enable --now ${UNIT_NAME}`,
      verify: (c) => verifyCommand(c, 'systemctl', ['is-enabled', UNIT_NAME]),
    });
    await confirmCezarRunning(ctx, 'sudo systemctl status cezar', 'sudo journalctl -u cezar -n 50 --no-pager');
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
  title: 'Verify the cockpit end-to-end (auth + HTTPS reach cezar)',
  async check() {
    return false; // always re-verify; it creates nothing
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would verify auth (401 for anon) AND that an authenticated request reaches cezar.');
      return { artifacts: [] };
    }
    const port = ctx.state.primaryPort;
    const https = ctx.state.publicUrl?.startsWith('https://') ?? false;
    const base = https ? 'https://127.0.0.1/' : 'http://127.0.0.1/';
    const tls = https ? ['-k'] : [];

    // 1) Is cezar actually listening on the loopback upstream? nginx challenges
    //    auth *before* proxying, so an anonymous 401 alone does NOT prove the
    //    backend is up — check the upstream directly.
    const upstreamUp = await isCezarUp(ctx, port);

    // 2) An anonymous request through nginx must be challenged (auth is active).
    const anonCode = await curlCode(ctx, [...tls, base]);
    const authEnforced = anonCode === '401';

    // 3) The real proof: an AUTHENTICATED request reaches cezar (2xx/3xx — not
    //    401/403 = bad creds, not 502/504 = upstream down). Credentials are read
    //    from stdin (curl -K -) so they never land in argv. `null` = not testable
    //    (a resume where the plaintext password is no longer in memory).
    let authedOk: boolean | null = null;
    const cred = ctx.prefs.cockpit;
    if (cred) {
      const code = await curlCode(ctx, [...tls, '-K', '-', base], { input: `user = "${cred.user}:${cred.password}"\n` });
      authedOk = /^[23]\d\d$/.test(code);
    }

    const url = ctx.state.publicUrl ?? `http://<this-server>`;
    const coreOk = upstreamUp && authEnforced && authedOk !== false;
    if (coreOk) {
      ctx.ui.success(
        `Cockpit is live at ${url} — ${authedOk ? 'an authenticated request reached cezar' : 'auth is enforced and cezar is up'}. ` +
          'Log in with the username and password you set.',
      );
      if (!https) {
        ctx.ui.warn(
          'This cockpit is HTTP-only (no domain/SSL configured). To serve it over HTTPS with this same auth, ' +
            're-run: cezar server-install --platform ubuntu-vps --reconfigure ssl',
        );
      }
      return { artifacts: [] };
    }

    const problems: string[] = [];
    if (!upstreamUp) problems.push(`cezar is not listening on 127.0.0.1:${port} — the service is down, so nginx returns 502`);
    if (!authEnforced) problems.push(`nginx did not challenge an anonymous request (got "${anonCode}") — basic auth may not be active`);
    if (authedOk === false) problems.push('an authenticated request did not reach cezar (bad credentials, or the upstream is down)');
    ctx.ui.error(
      `The cockpit is NOT fully working yet:\n` +
        problems.map((p) => `  • ${p}`).join('\n') +
        `\n\nDiagnostics on the server:\n` +
        `  • systemctl --user status cezar   (or: sudo systemctl status cezar)\n` +
        `  • sudo systemctl status nginx && sudo nginx -t\n` +
        `  • sudo ss -ltnp | grep -E ':80|:443|:${port}'\n` +
        `  • ports 80/443 open in ufw AND any cloud firewall (Hetzner/AWS)`,
    );
    // Fail the run so `installed` stays false and the exit code is non-zero —
    // "complete" must mean the cockpit actually works. Re-run to resume (the
    // service/proxy steps are idempotent).
    throw new StepAborted('cockpit verification failed — see the diagnostics above');
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
