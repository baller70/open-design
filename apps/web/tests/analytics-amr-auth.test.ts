// amr_auth_result single-flight contract. One sign-in attempt is observed
// by several pollers at once (the initiating surface plus every mounted
// AmrLoginPill woken by AMR_LOGIN_STATUS_EVENT), and each reports the
// outcome it sees. These tests pin the begin/resolve gate in
// analytics/amr-auth.ts: exactly one amr_auth_result per attempt, first
// terminal outcome wins, attribution carried from the amr_entry click.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AmrEntryAttribution } from '@open-design/contracts/analytics';
import {
  beginAmrAuthTracking,
  resolveAmrAuthTracking,
} from '../src/analytics/amr-auth';

const attribution: AmrEntryAttribution = {
  entryId: 'od-amr-test-entry',
  sourceProduct: 'open_design',
  sourceDetail: 'inline_model_switcher_amr_row',
  occurredAt: new Date().toISOString(),
};

describe('amr-auth single-flight tracking', () => {
  const track = vi.fn();

  beforeEach(() => {
    track.mockClear();
    // Drain any attempt a previous test left armed.
    resolveAmrAuthTracking(() => undefined, 'cancelled');
  });

  it('fires one amr_auth_result with attribution on success', () => {
    beginAmrAuthTracking(attribution, Date.now() - 1500);
    resolveAmrAuthTracking(track, 'success');
    expect(track).toHaveBeenCalledTimes(1);
    const [event, props] = track.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('amr_auth_result');
    expect(props).toMatchObject({
      page_name: 'chat_panel',
      area: 'amr_auth',
      result: 'success',
      entry_id: 'od-amr-test-entry',
      source_detail: 'inline_model_switcher_amr_row',
    });
    expect(props.duration_ms).toBeGreaterThanOrEqual(1500);
    expect(props).not.toHaveProperty('error_code');
  });

  it('ignores later resolves for the same attempt (concurrent pollers)', () => {
    beginAmrAuthTracking(attribution);
    resolveAmrAuthTracking(track, 'success');
    resolveAmrAuthTracking(track, 'failed', 'login_stopped');
    resolveAmrAuthTracking(track, 'cancelled');
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing is armed', () => {
    resolveAmrAuthTracking(track, 'success');
    expect(track).not.toHaveBeenCalled();
  });

  it('falls back to the settings page when login starts without attribution', () => {
    beginAmrAuthTracking(null);
    resolveAmrAuthTracking(track, 'timeout', 'login_timeout');
    const [, props] = track.mock.calls[0] as [string, Record<string, unknown>];
    expect(props).toMatchObject({
      page_name: 'settings',
      result: 'timeout',
      error_code: 'login_timeout',
    });
    expect(props).not.toHaveProperty('entry_id');
    expect(props).not.toHaveProperty('source_detail');
  });

  it('lets a new attempt supersede a stale armed one', () => {
    beginAmrAuthTracking(attribution);
    beginAmrAuthTracking(null);
    resolveAmrAuthTracking(track, 'failed', 'spawn_failed');
    expect(track).toHaveBeenCalledTimes(1);
    const [, props] = track.mock.calls[0] as [string, Record<string, unknown>];
    expect(props).toMatchObject({ page_name: 'settings', result: 'failed' });
  });
});
