import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetAntigravityModelLockForTests,
  acquireAntigravityModelLock,
  waitForAgyToReadModel,
} from '../../src/runtimes/defs/antigravity.js';

afterEach(() => {
  _resetAntigravityModelLockForTests();
});

describe('acquireAntigravityModelLock', () => {
  // The lock chain is the per-process serialization that protects
  // `~/.gemini/antigravity-cli/settings.json` from concurrent
  // non-default model writes. Two concurrent spawns must not both
  // write the file before the first one's agy has actually read it —
  // otherwise the first run executes on the second run's model.
  // Pin both the ordering (B does not enter until A releases) AND
  // the no-deadlock contract (releasing A unblocks B without manual
  // intervention).
  it('serializes concurrent acquirers — second waits for first release', async () => {
    const events: string[] = [];

    const releaseA = await acquireAntigravityModelLock();
    events.push('A-acquired');

    // Kick off B in parallel — it should NOT acquire until A releases.
    const bPromise = acquireAntigravityModelLock().then((release) => {
      events.push('B-acquired');
      return release;
    });

    // Yield to the event loop several times so B has every chance to
    // resolve early if the serialization were broken.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(events).toEqual(['A-acquired']);

    releaseA();
    const releaseB = await bPromise;
    expect(events).toEqual(['A-acquired', 'B-acquired']);

    releaseB();
  });

  // Three+ concurrent acquirers should FIFO through the chain. A
  // future refactor that drops the awaited `previous` reference would
  // let later acquirers leapfrog earlier ones, which is exactly the
  // race we're guarding against.
  it('FIFOs three concurrent acquirers', async () => {
    const events: string[] = [];
    const releaseA = await acquireAntigravityModelLock();
    events.push('A-acquired');

    const bPromise = acquireAntigravityModelLock().then((rel) => {
      events.push('B-acquired');
      return rel;
    });
    const cPromise = acquireAntigravityModelLock().then((rel) => {
      events.push('C-acquired');
      return rel;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['A-acquired']);

    releaseA();
    const releaseB = await bPromise;
    expect(events).toEqual(['A-acquired', 'B-acquired']);

    releaseB();
    const releaseC = await cPromise;
    expect(events).toEqual(['A-acquired', 'B-acquired', 'C-acquired']);

    releaseC();
  });
});

describe('waitForAgyToReadModel', () => {
  // The polling helper resolves true when agy's --log-file matches the
  // upstream `Propagating selected model override to backend:
  // label="<X>"` line, which is the signal that settings.json was
  // read. This is the lock-release trigger in the spawn pipeline —
  // breaking the pattern match would either release the lock too
  // early (concurrent races re-emerge) or never release it (queue
  // starvation).
  it('resolves true when the expected propagation line appears', async () => {
    let now = 0;
    const reads: string[] = [];
    let calls = 0;
    const result = await waitForAgyToReadModel(
      '/fake/log/path',
      'Gemini 3.1 Pro (High)',
      {
        timeoutMs: 5_000,
        pollIntervalMs: 10,
        now: () => now,
        readFile: async (path) => {
          reads.push(path);
          calls++;
          if (calls < 3) {
            return 'I0529 boot ...\nE0529 still loading ...\n';
          }
          return (
            'I0529 model_config_manager.go:157] Propagating selected model '
            + 'override to backend: label="Gemini 3.1 Pro (High)"\n'
          );
        },
      },
    );
    expect(result).toBe(true);
    expect(reads.every((p) => p === '/fake/log/path')).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  // Model labels carry parentheses and slashes ("Gemini 3.5 Flash
  // (Medium)", "GPT-OSS 120B (Medium)") — the regex must escape regex
  // metacharacters so the literal label matches. A naive
  // `new RegExp(label)` would interpret the parens as a capture group
  // and silently match the wrong model.
  it('escapes regex metacharacters in the expected model label', async () => {
    const log =
      'I0529 model_config_manager.go] Propagating selected model '
      + 'override to backend: label="GPT-OSS 120B (Medium)"';
    const result = await waitForAgyToReadModel(
      '/fake/log',
      'GPT-OSS 120B (Medium)',
      {
        timeoutMs: 100,
        pollIntervalMs: 5,
        readFile: async () => log,
      },
    );
    expect(result).toBe(true);
  });

  // Must not match a DIFFERENT model just because the prefix overlaps.
  // Concurrent runs A (Gemini Pro) and B (Gemini Pro Low) could
  // otherwise have B's lock released by A's propagation line.
  it('does not match a different model label that shares a prefix', async () => {
    const log =
      'I0529 model_config_manager.go] Propagating selected model '
      + 'override to backend: label="Gemini 3.1 Pro (Low)"';
    const result = await waitForAgyToReadModel(
      '/fake/log',
      'Gemini 3.1 Pro (High)',
      {
        timeoutMs: 30,
        pollIntervalMs: 5,
        readFile: async () => log,
      },
    );
    expect(result).toBe(false);
  });

  // Missing / unreadable log file (agy hasn't created it yet, or a
  // restricted tmpfs) must not throw — the polling loop swallows the
  // error and keeps retrying. Without this, a transient read failure
  // would propagate up and crash the spawn pipeline.
  it('swallows read errors and returns false on timeout', async () => {
    const result = await waitForAgyToReadModel(
      '/nonexistent/log',
      'Gemini 3.1 Pro (High)',
      {
        timeoutMs: 30,
        pollIntervalMs: 5,
        readFile: async () => {
          throw new Error('ENOENT: file not found');
        },
      },
    );
    expect(result).toBe(false);
  });
});
