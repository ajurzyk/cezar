# Codex-desktop-parity UI redesign (React + shadcn/ui)

Status: draft — skeleton; research in progress
Run plan: `.ai/runs/2026-07-14-codex-ui-redesign-spec.md`

## TLDR

Rebuild cezar's cockpit (`web/`) as a React + Vite + Tailwind + shadcn/ui app with the look, feel and interaction quality of OpenAI's Codex desktop app — while keeping **every** feature cezar has today (runs, variants, review gate, plan mode, workflows, multi-agent backends, skills, GitHub tab, inbox, repo view). The redesign is driven by a **normalized agent-event protocol** (informed by Claude Code stream-json, Codex app-server, OpenCode SSE, and ACP) so tool calls, todo/plan checklists, statuses and token usage render first-class regardless of backend. It adds a real per-session **git view** (Changes/Files tabs, superb diffs and syntax highlighting, commit/push/branch, View PR) behind a **forge-driver seam** (GitHub now, GitLab-ready), a **Settings** tab (skills now; MCP and more later — coding-agent-agnostic), a full-screen **new-task** experience, handoff actions (terminal, VS Code), dictation labeling in the composer, and system-prompt support. Mobile-first: it must work great on an iPhone. Simplicity stays the product's core value.

## Decisions (resolved with the user, 2026-07-14)

1. Full React + Vite + Tailwind + shadcn/ui rewrite of `web/`, built to static assets, served by the existing Hono server. End users still get zero-config `npx cezar-cli`.
2. One master spec; protocol layer, git GUI + drivers, and settings are phases within it.
3. Git GUI depth: review + ship actions (diffs, commit, push, branch, PR) — no hunk-staging or rebase UI. GitHub-only forge driver for now; forge features hidden when unavailable.

## Problem Statement

*(to fill: current vanilla-JS UI limits — issues #377–#390, cramped sidebar composer, tool-result rendering, no todo/plan rendering, git look & feel, inconsistent selects, mobile)*

## Research

*(to fill from `.ai/analysis/` notes: Codex desktop UX, Claude Code, opencode web, paseo, mercato-sandboxes visual language, protocol comparison)*

## Proposed Solution

*(to fill)*

## Architecture

*(to fill: web/src React app, build pipeline, Hono static serving, normalized event protocol module, forge-driver seam, settings registry)*

## Normalized agent-event protocol

*(to fill: item/turn lifecycle, tool-call status enum, plan items, usage, permissions — mapping table per backend)*

## UI/UX — view by view

*(to fill: shell/navigation, run thread, composer, new task, git view, task list/table, workflows, skills, github, inbox, settings, mobile rules)*

## Design system

*(to fill: tokens from mercato-sandboxes + Codex-style typography, shadcn theme, dark/light, animations)*

## Edge Cases & Failure Scenarios

*(to fill)*

## Risks & Impact Review

*(to fill)*

## Phasing

*(to fill)*

## Implementation Plan

*(to fill: phases → numbered testable steps, each leaves the app working)*
