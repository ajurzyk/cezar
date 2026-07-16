# Remote access — Ubuntu / Debian VPS

Host the cezar cockpit on a bare Ubuntu/Debian server, reachable over the
internet, behind a login and (optionally) HTTPS.

**How it's wired:** cezar itself stays **loopback-bound** (`127.0.0.1:4321`,
`CEZ_REMOTE=1`). **nginx** is the only public surface — it terminates TLS,
challenges every request with HTTP Basic-Auth, and proxies to cezar. A systemd
service keeps cezar running and restarts it on boot.

```
  internet ──HTTPS──► nginx (:443)  ──proxy──►  cezar (127.0.0.1:4321)
                      basic-auth + Let's Encrypt         systemd service
```

The wizard never escalates silently: **every privileged command is printed**,
and you choose to run it via `sudo` or paste it into a root shell yourself. Each
command is verified before the installer moves on.

---

## Prerequisites

- Ubuntu/Debian VPS with `apt`, reachable over SSH.
- A **normal, sudo-capable user** (the wizard refuses to run as root).
- At least one logged-in agent CLI on that user — `claude`, `codex`, or
  OpenCode. (The installer can install `gh` and the npm-based CLIs for you.)
- For HTTPS: a domain with a DNS `A`/`AAAA` record pointing at the box.

> Tools installed in `~/.local/bin` or via nvm are found automatically — the
> installer merges your **login-shell PATH** before probing, so `claude`/`gh`
> are detected even when launched non-interactively.

---

## Install

From a published release:

```bash
npx cezar-cli server-install --platform ubuntu-vps
```

Or from a git checkout on the box:

```bash
git clone https://github.com/open-mercato/cezar && cd cezar
npm install && npm run build
node dist/index.js server-install --platform ubuntu-vps
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects `claude` / `codex` / `opencode` / `gh` / `git`; offers to install the missing ones. At least one agent CLI is required. |
| **Reverse proxy** | Installs **nginx**, writes an `auth_basic` + SSE-safe proxy vhost, creates the **htpasswd** identity file, and — if `ufw` is active — allows `Nginx Full` (ports 80/443). |
| **Domain + SSL** *(optional)* | Points the vhost's `server_name` at your domain, then runs `certbot --nginx` for a Let's Encrypt certificate with auto-redirect. Skippable — you can add it later. |
| **Service** | Installs a **systemd** unit (rootless `--user` + linger where possible, else a system unit), **starts cezar now**, enables it on boot, and waits for it to answer on the loopback port. |
| **Verify** | Confirms an anonymous request is challenged (401) **and** that an authenticated request actually reaches cezar (2xx/3xx) — a real end-to-end check, not just "nginx is up". |

### Setting the cockpit login

During the reverse-proxy step you pick the **username** (defaults to your OS
user) and a **password** — either type your own or let the installer **generate
a strong one** (shown once, so save it). This is the HTTP Basic-Auth credential
you enter in the browser over HTTPS. cezar stores only a hash.

### The privileged-command prompt

For each root action you're asked:

- **"I'll run it myself as root"** (default) — the installer prints the exact
  command; you paste it into a root shell, then confirm. File writes show the
  **decoded** file content first, so nothing is hidden inside base64.
- **"Run it now via sudo"** — the installer runs it for you and streams output.

Your choice is remembered for the rest of the run.

---

## Updating / redeploying a new version

Once a new cezar is available (a fresh local build, or a newly published
`cezar-cli`), reload the running service with one standardized command:

```bash
cezar server-deploy --platform ubuntu-vps
#   from a checkout:  node dist/index.js server-deploy --platform ubuntu-vps
#   npm script:       npm run server-deploy -- --platform ubuntu-vps
```

`server-deploy` reloads systemd, **restarts the cezar service**, waits for it to
answer, and re-runs the same authenticated end-to-end check as install — so a
green deploy means the cockpit is actually serving the new version.

- **From a checkout** the service runs `<node> <repo>/dist/index.js` — so build
  first, then deploy: `git pull && npm run build && cezar server-deploy --platform ubuntu-vps`.
- **Via npx** the service runs `npx --yes cezar-cli` — a restart pulls the latest
  published version, so `server-deploy` alone is enough.

The installer is also **idempotent** if you need to change the setup itself:

- `--reconfigure <ids>` — force specific steps (`deps,nginx-proxy,ssl,autostart,identity`).
- `--reinstall` — force **every** step (rewrites the unit, htpasswd, vhost…).
- `--reconfigure ssl` — add HTTPS to an existing HTTP-only install (needs a domain).

> Use `--reconfigure autostart` (not just `server-deploy`) when the **unit file
> itself** changed — e.g. after upgrading the installer — since a restart alone
> won't rewrite it.

---

## Uninstall

```bash
node dist/index.js server-uninstall --platform ubuntu-vps
```

Removes what cezar **owns**: the nginx vhost, htpasswd, systemd unit, and boot
linger (when this install enabled it); the distro's default nginx site is
re-enabled if the install disabled it. Shared tools it merely *lists* for you
to remove by hand (agent CLIs, `gh`, and — when this install added them —
`nginx` and `certbot` packages, plus the TLS certificate: pulling a cert can
break other vhosts).

---

## Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `502 Bad Gateway` | cezar isn't running. `systemctl status cezar` / `journalctl -u cezar -n 50`. |
| `status=203/EXEC — Unable to locate executable` | An old unit with a bare `ExecStart`. Re-run `--reconfigure autostart`; the unit now uses an absolute `<node> <entry>`. |
| "no gh / claude installed" but you have them | Launched from a non-login shell without `~/.local/bin`/nvm on PATH. The current installer merges your login-shell PATH; update and re-run. |
| certbot "verification failed" but it succeeded | Fixed — verification now reads the world-readable nginx vhost, not root-only `/etc/letsencrypt/live`. |
| Cockpit unreachable, nginx fine | Ports 80/443 blocked. Check `ufw status` **and** any cloud firewall (Hetzner/AWS security groups). |

← Back to [Remote access overview](./README.md)
