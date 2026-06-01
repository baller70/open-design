import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { createCommandLaunchDescriptor } from '../src/launcher/launch.js';
import { createPollStatusVerificationHandle, pollVerificationHandle } from '../src/launcher/verification.js';

function writeNodeWrapper(sourceLines: string[]): { dir: string; bin: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'od-launch-contract-'));
  const bin = path.join(dir, 'wrapper.mjs');
  writeFileSync(bin, ['#!/usr/bin/env node', ...sourceLines].join('\n'), 'utf8');
  chmodSync(bin, 0o755);
  return { dir, bin };
}

test('explicit command descriptors stay platform-neutral while repairing child PATH for absolute wrappers', () => {
  const { dir, bin } = writeNodeWrapper(['console.log("ok");']);
  try {
    const descriptor = createCommandLaunchDescriptor({
      command: bin,
      args: [],
      baseEnv: { PATH: '' },
      executionMode: 'probe',
    });
    const pathKey = Object.keys(descriptor.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    const value = descriptor.env[pathKey] ?? '';
    assert.match(value, new RegExp(path.dirname(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(value, new RegExp(path.dirname(bin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(descriptor.diagnostics.executionMode, 'probe');
    assert.equal(descriptor.diagnostics.launchKind, 'explicit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('poll-status verification driver stays generic', async () => {
  let attempts = 0;
  const result = await pollVerificationHandle(
    createPollStatusVerificationHandle({
      kind: 'poll-status',
      poll: async () => ({ attempts: ++attempts, ready: attempts >= 2 }),
      isVerified: (value) => value.ready,
    }),
    { intervalMs: 1, timeoutMs: 100 },
  );

  assert.equal(result.status, 'verified');
  if (result.status === 'verified') {
    assert.equal(result.value.attempts, 2);
  }
});

test('migrated agent-adjacent files no longer raw-spawn processes directly', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  for (const relPath of [
    'apps/daemon/src/integrations/vela.ts',
    'apps/daemon/src/codex-cli.ts',
    'apps/daemon/src/acp.ts',
  ]) {
    const source = readFileSync(path.join(repoRoot, relPath), 'utf8');
    assert.equal(source.includes('spawn('), false, `${relPath} should use the launch contract instead of raw spawn()`);
  }
});
