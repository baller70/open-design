---
id: 20260601-launch-contract
name: Launch Contract Unification for AMR Login, Codex MCP, and ACP Probe
status: planned
created: '2026-06-01'
---

## Overview

### Problem Statement

Open Design has multiple daemon-owned, agent-adjacent subprocess entrypoints that resolve binaries, shape environment variables, and spawn child processes independently. That fragmentation already caused one confirmed Windows AMR bug and one confirmed Codex MCP sibling bug:

- `spawnVelaLogin()` can fail to re-launch a Node/npm-style `vela` wrapper after logout because the child environment does not receive the same launch-time PATH repair used by normal runtime launches.
- `codex-cli.ts` shells out to `codex` directly, bypassing the runtime launcher path that upgrades Codex to its native binary and repairs PATH for wrapper launches.

The ACP model-detection helper is not a confirmed production failure today, but it still raw-spawns the probe command and depends on callers to have already normalized launch environment correctly. That makes it the nearest recurrence point for the same bug class.

### Goals

- Introduce one daemon-side launch contract for agent-adjacent subprocesses.
- Reuse the same contract for AMR login, Codex MCP CLI calls, and ACP model detection in the first slice.
- Preserve current user-visible product behavior while removing duplicated launch-path logic.
- Add focused regression coverage for wrapper launches under stripped PATH environments.

### Non-Goals

- Do not broaden this change into desktop, packaged, editor-opening, browser-opening, or generic tooling subprocess cleanup.
- Do not redesign AMR login UX, Codex MCP UX, or ACP session semantics.
- Do not add a Linux-specific caller migration in this slice.
- Do not replace existing runtime launch/detection flows that are already correct unless they need small shared-helper integration.

## Design

### Launch Contract

Add a daemon-owned launch contract with two adjacent modules:

- `launch`: resolves the best launch target, normalizes env, shapes a canonical invocation, and exposes structured diagnostics.
- `verification`: defines generic post-launch verification handles and a reusable polling driver without naming product-specific strategies.

The launch contract is the only allowed entrypoint for agent-adjacent daemon subprocesses in this slice.

### Input Lanes

Support two lanes:

- Typed runtime/agent lane: accepts an `agentId` / runtime def path and uses the existing runtime registry, executable resolution, and env normalization rules.
- Generic explicit-command lane: accepts explicit commands for adjacent user-facing CLIs while still applying the same PATH repair and invocation shaping. When the command is a known runtime CLI such as Codex, the lane can opt into the typed resolution path so native-binary upgrade and wrapper-safe launch semantics still apply.

### Launch Semantics

Keep the existing “best available launch target” behavior:

- preserve the configured override path
- preserve the PATH-visible resolved path
- preserve the final launch path
- preserve launch-kind metadata such as native-binary upgrade

Standardize the execution mode vocabulary:

- `probe`
- `interactive-run`
- `fire-and-forget`
- `auth-setup-cli`
- `bounded-cli`

Keep caller-controlled:

- `cwd`
- detached/background intent

Standardize per execution mode:

- timeout policy
- stdout/stderr capture semantics
- spawn invocation shape
- Windows verbatim-argument handling

### Verification Contract

The verification module should define generic typed handles such as `poll-status` and a reusable polling driver. Product code maps those generic handles to product-specific status readers one layer above the launcher.

For this slice:

- AMR login continues to use the existing `/api/integrations/vela/status` polling model at the product layer.
- The new launch contract only establishes the generic verification interface and reusable driver so future auth/setup flows do not re-implement retry loops ad hoc.

### Diagnostics

The internal launch descriptor should expose:

- configured override path
- PATH-visible resolved path
- final launch path
- normalized env
- args
- platform-specific spawn flags
- execution mode

Selected diagnostic fields may continue to surface through existing diagnostic-bearing APIs where helpful, but the full launcher payload remains internal to daemon logs and tests.

## Implementation Plan

1. Add the launch contract modules and keep their exports narrow.
2. Migrate `spawnVelaLogin()` to the new `auth-setup-cli` launch mode.
3. Migrate `codex-cli.ts` to the generic explicit-command lane with Codex-aware typed resolution.
4. Migrate ACP model detection to the same launch contract so it no longer owns a raw `spawn()` seam.
5. Add lightweight guardrails in `apps/daemon/src` so the migrated agent-adjacent files cannot regress back to direct raw spawn calls.
6. Save Linux scope for contract/test compatibility only in this PR.

## Success Criteria

- AMR logout followed by login no longer depends on ad hoc PATH repair in `spawnVelaLogin()`.
- Codex MCP probe/install/remove no longer shell out through a raw `spawn('codex', ...)` path.
- ACP model detection no longer raw-spawns its probe command directly.
- Focused wrapper-launch regression tests reproduce the previous failure shape and pass through the new contract.
- The change remains limited to daemon agent-adjacent launch paths.

## Test Plan

- Add a focused AMR regression test:
  - use a Node-based fake `vela` wrapper
  - use a stripped child PATH
  - verify logout clears local state
  - verify re-login succeeds through the new launch contract
- Add a focused Codex regression test:
  - simulate Codex CLI launch through the new helper under a stripped child PATH
  - verify the bounded CLI path succeeds once the launcher repairs the child PATH and invocation
- Add a focused ACP regression test:
  - use a Node-based ACP probe wrapper under a stripped child PATH
  - verify model detection succeeds through the new launch contract
- Add a guardrail test for the migrated files so they no longer contain raw `spawn()` entrypoints.
- Run:
  - `pnpm --filter @open-design/daemon test -- <targeted tests>`
  - `pnpm --filter @open-design/daemon typecheck`
  - `pnpm typecheck`
  - `pnpm guard`

## Assumptions

- Use the repository change-spec convention under `specs/change/`.
- Keep this PR intentionally narrow and daemon-focused.
- Linux compatibility in this slice means contract/test neutrality, not extra caller migration.
