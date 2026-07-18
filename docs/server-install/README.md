# Remote access — host cezar on a server

By default the cezar cockpit runs on `localhost`. To reach it from another
machine — a shared team box, a VPS, your phone — put an **authenticated public
front** in front of it. cezar ships an interactive, dependency-free installer
that does exactly that, modularized by **platform strategy**.

The wizard never escalates silently: **every privileged command is printed and
verified**, and you choose to run it via `sudo` or paste it into a root shell
yourself. It's idempotent and resumable, and it ends with a real
**authenticated end-to-end check** — so "complete" means the cockpit actually
works behind its login.

```bash
npx cezar-cli server-install   --platform <id>   # install
npx cezar-cli server-deploy    --platform <id>   # redeploy a new version (reload the service)
npx cezar-cli server-uninstall --platform <id>   # reverse it
```

## Available providers

| Provider | `--platform` | Public front | Identity | Autostart | Guide |
|----------|--------------|--------------|----------|-----------|-------|
| **Ubuntu / Debian VPS** | `ubuntu-vps` | nginx + Let's Encrypt (HTTPS) | HTTP Basic-Auth (htpasswd) | systemd | [Step-by-step →](./ubuntu-vps.md) |
| **macOS + ngrok** | `macosx-ngrok` | ngrok tunnel (HTTPS) | ngrok `--basic-auth` | launchd | [Step-by-step →](./macosx-ngrok.md) |

Same engine, different steps — each strategy is a small registry entry, so new
platforms slot in without touching the engine.

> **Several domains on one box?** `ubuntu-vps` can host multiple independent
> cockpits — add `--domain <host>` to install/deploy/uninstall a separate
> instance (its own port, nginx site, login and service). A new `--domain` never
> resumes the first install. See
> [Hosting several cockpits on one box](./ubuntu-vps.md#hosting-several-cockpits-on-one-box-multiple-domains).

## How it works (all providers)

1. **Dependencies** — detect the agent CLIs (`claude`/`codex`/`opencode`),
   `gh`, `git`; offer to install what's missing. (Tools in `~/.local/bin` / nvm
   are found via your login-shell PATH.)
2. **Public front** — stand up the reverse proxy / tunnel that terminates
   TLS and challenges every request for a login.
3. **Identity** — a username + password (type your own or auto-generate a
   strong one). cezar stores only a hash; the app stays bound to loopback.
4. **Autostart** — a service (systemd / launchd) that starts cezar now and
   keeps it up across reboots.
5. **Verify** — confirm an anonymous request is challenged **and** an
   authenticated one reaches cezar.

## Redeploying a new version

`npx cezar-cli server-deploy --platform <id>` is the standardized, per-strategy way to
roll out a new cezar: it restarts the service and re-verifies. See each guide's
**Updating / redeploying** section for the checkout-vs-npx details.

To test an unreleased build on a server, pin a preview version
(see [Preview builds](../publishing.md)) — for example roll a box to a PR's
exact snapshot with `npx cezar-cli@<version> server-deploy --platform <id>`,
or track a branch with `npx cezar-cli@develop server-deploy --platform <id>`.

---

Guides: **[Ubuntu / Debian VPS](./ubuntu-vps.md)** · **[macOS + ngrok](./macosx-ngrok.md)**
