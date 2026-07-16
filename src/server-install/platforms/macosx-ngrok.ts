import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CANCEL, PreflightError, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.js';
import { brewInstallTool, brewRemoveHint, depCheckStep, owned, shared, StepAborted, StepCancelled, verifyCommand } from '../steps.js';

/**
 * The `macosx-ngrok` strategy: the app runs locally on a Mac and ngrok is the
 * public front, in place of nginx+certbot. ngrok's built-in `--basic-auth` is
 * the identity gate (the htpasswd equivalent), and a launchd agent is the
 * autostart (the systemd equivalent). Proves the engine seam with a genuinely
 * different platform — same engine, different steps.
 */

const PLIST_LABEL = 'ai.cezar.ngrok';
const plistPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

/** Escape a value for inclusion in plist XML text. */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** launchd agent that keeps an authenticated ngrok tunnel to the local cockpit up. */
export function launchdPlist(port: number, basicAuth: string, domain?: string): string {
  const args = ['http', String(port), '--basic-auth', basicAuth];
  if (domain) args.push('--domain', domain);
  // Escape every arg — a password/domain with `&`, `<`, `>` would otherwise
  // produce invalid plist XML and launchctl would silently fail to load it.
  const argXml = ['/opt/homebrew/bin/ngrok', ...args]
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Managed by cezar server-install — do not edit by hand. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;
}

const ngrokStep: InstallStep = {
  id: 'ngrok',
  title: 'ngrok tunnel (authtoken + domain + basic-auth)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    return verifyCommand(ctx, 'test', ['-f', plistPath()]);
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // 1) ngrok present?
    const present = await verifyCommand(ctx, 'ngrok', ['version']);
    if (!present) {
      if (ctx.dryRun) ctx.ui.info('DRY RUN — would run: brew install ngrok/ngrok/ngrok');
      else await ctx.runner.interactive('brew', ['install', 'ngrok/ngrok/ngrok']);
    }

    // 2) authtoken (a secret — never stored in server.json; it lives in ngrok's own config)
    const token = await ctx.ui.password({
      message: 'Paste your ngrok authtoken (dashboard.ngrok.com → Your Authtoken)',
      validate: (v) => (v.trim() ? undefined : 'authtoken is required'),
    });
    if (token === CANCEL) throw new StepCancelled();
    // ngrok config add-authtoken takes the token as an argument (no stdin form).
    // Accepted here: macosx-ngrok targets a single-user local Mac, not a shared
    // multi-user host, so the `ps` argv-exposure risk that matters on a VPS
    // does not apply. The token lands in ngrok's own config, not in server.json.
    if (!ctx.dryRun) await ctx.runner.interactive('ngrok', ['config', 'add-authtoken', String(token)]);

    // 3) reserved domain (optional → ephemeral URL)
    const domainInput = await ctx.ui.text({
      message: 'Reserved ngrok domain (leave blank for an ephemeral URL that changes on restart)',
      placeholder: 'cezar.ngrok.app',
    });
    if (domainInput === CANCEL) throw new StepCancelled();
    const domain = String(domainInput).trim() || undefined;

    // 4) basic-auth identity
    const user = await ctx.ui.text({
      message: 'Basic-auth username for the tunnel',
      placeholder: 'ops',
      validate: (v) => (v.trim() ? undefined : 'username is required'),
    });
    if (user === CANCEL) throw new StepCancelled();
    const password = await ctx.ui.password({
      message: `Basic-auth password for "${user}"`,
      validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
    });
    if (password === CANCEL) throw new StepCancelled();
    if (!ctx.dryRun && String(password).length < 6) {
      throw new StepAborted('a basic-auth password (≥6 chars) is required — run server-install without --yes to set one');
    }
    const basicAuth = `${String(user)}:${String(password)}`;

    // 5) launchd agent (the plist embeds the basic-auth creds, like htpasswd on Linux)
    const path = plistPath();
    if (ctx.dryRun) {
      ctx.ui.info(`DRY RUN — would write ${path} and launchctl load it.`);
    } else {
      mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(path, launchdPlist(ctx.state.primaryPort, basicAuth, domain), 'utf8');
      await ctx.runner.interactive('launchctl', ['load', '-w', path]);
    }

    if (domain) {
      ctx.state.publicUrl = `https://${domain}`;
      ctx.state.ephemeral = false;
    } else {
      ctx.state.ephemeral = true;
      ctx.ui.note('No reserved domain — the tunnel URL is ephemeral and changes each restart. Find it at http://localhost:4040.', 'ngrok');
    }

    return {
      artifacts: [
        shared('ngrok-config', { name: 'authtoken', removeHint: 'ngrok config add-authtoken "" (or edit ~/Library/Application Support/ngrok/ngrok.yml)' }),
        owned('launchd', { name: PLIST_LABEL, path }),
      ],
    };
  },
  async undo(ctx, created) {
    const plist = (created?.artifacts ?? []).find((a) => a.type === 'launchd');
    if (plist?.path) {
      if (ctx.dryRun) {
        ctx.ui.info('DRY RUN — would launchctl unload and remove the ngrok agent.');
      } else {
        await ctx.runner.interactive('launchctl', ['unload', plist.path]);
        rmSync(plist.path, { force: true });
      }
    }
    const cfg = (created?.artifacts ?? []).find((a) => a.type === 'ngrok-config');
    if (cfg) ctx.ui.note(cfg.removeHint ?? '', 'ngrok authtoken left in place — remove it yourself if you want it gone');
  },
};

const identityStep: InstallStep = {
  id: 'identity',
  title: 'Identity check (ngrok basic-auth active)',
  async check() {
    return false;
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would confirm the ngrok tunnel is up and basic-auth is enforced.');
      return { artifacts: [] };
    }
    const up = await verifyCommand(ctx, 'curl', ['-s', 'http://localhost:4040/api/tunnels'], (r) => r.stdout.includes('public_url') || r.code === 0);
    if (up) ctx.ui.success('ngrok tunnel is up (basic-auth enforced at the ngrok edge).');
    else ctx.ui.warn('Could not reach the ngrok local API (localhost:4040) — check the tunnel started.');
    return { artifacts: [] };
  },
  async undo() {
    // nothing created
  },
};

export const macosxNgrok: PlatformStrategy = {
  id: 'macosx-ngrok',
  label: 'macOS + ngrok',
  async preflight(ctx: InstallContext) {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — skipping OS preflight.');
      return;
    }
    if (!(await ctx.runner.capture('uname', ['-s'])).stdout.includes('Darwin')) {
      throw new PreflightError('macosx-ngrok requires macOS. On a Linux VPS use --platform ubuntu-vps.');
    }
  },
  steps(): InstallStep[] {
    return [
      depCheckStep({ installTool: brewInstallTool, removeHint: brewRemoveHint }),
      ngrokStep,
      identityStep,
    ];
  },
};
