import { describe, expect, test } from 'vitest';
import {
  backoffMs,
  canResume,
  classifyError,
  describePause,
  initialRateLimitState,
  isResumable,
  msUntilResume,
  recordFailure,
  recordSuccess,
} from './rateLimit.js';

describe('classifyError', () => {
  test('classifies provider rate-limit errors (429)', () => {
    const err = new Error(JSON.stringify({ error: 'XAI is rate limiting your requests' }));
    expect(classifyError(err).kind).toBe('rate-limit');
  });

  test('classifies overloaded errors (529)', () => {
    const err = new Error(JSON.stringify({ error: "Anthropic's API is temporarily overloaded" }));
    expect(classifyError(err).kind).toBe('overloaded');
  });

  test('classifies auth errors', () => {
    expect(classifyError(new Error('Invalid API key')).kind).toBe('auth');
    expect(classifyError({ status: 401, message: 'nope' }).kind).toBe('auth');
  });

  test('uses numeric status when present', () => {
    expect(classifyError({ status: 429 }).kind).toBe('rate-limit');
    expect(classifyError({ statusCode: 529 }).kind).toBe('overloaded');
  });

  test('extracts retry-after when provided', () => {
    expect(classifyError({ status: 429, retryAfter: 12 }).retryAfterMs).toBe(12000);
    expect(classifyError('rate limit, retry-after: 5').retryAfterMs).toBe(5000);
  });

  test('only rate-limit/overloaded are resumable', () => {
    expect(isResumable('rate-limit')).toBe(true);
    expect(isResumable('overloaded')).toBe(true);
    expect(isResumable('auth')).toBe(false);
    expect(isResumable('other')).toBe(false);
  });
});

describe('backoffMs', () => {
  test('is deterministic with injected jitter and grows with failures', () => {
    expect(backoffMs(1, 0)).toBe(500);
    expect(backoffMs(1, 0.5)).toBe(1000);
    expect(backoffMs(3, 0)).toBe(2000);
  });

  test('is capped at 60s', () => {
    expect(backoffMs(50, 1)).toBe(60000);
  });
});

describe('recordFailure / resume lifecycle', () => {
  test('pauses on a resumable failure and schedules a resume time', () => {
    const state = initialRateLimitState();
    const result = recordFailure(state, new Error('rate limit (429)'), 1000, 0);
    expect(result.paused).toBe(true);
    expect(result.state.consecutiveFailures).toBe(1);
    expect(result.state.resumeAt).toBe(1500); // 1000 + backoffMs(1, 0)
    expect(result.state.lastKind).toBe('rate-limit');
  });

  test('honours an explicit retry-after over backoff', () => {
    const state = initialRateLimitState();
    const result = recordFailure(state, { status: 429, retryAfter: 30 }, 1000, 0);
    expect(result.state.resumeAt).toBe(31000);
  });

  test('does not pause on a non-resumable (auth) failure', () => {
    const state = initialRateLimitState();
    const result = recordFailure(state, new Error('Invalid API key'), 1000, 0);
    expect(result.paused).toBe(false);
    expect(result.state.resumeAt).toBeNull();
    expect(result.state.lastKind).toBe('auth');
  });

  test('canResume / msUntilResume gate on the resume time', () => {
    const { state } = recordFailure(initialRateLimitState(), new Error('overloaded (529)'), 1000, 0);
    expect(canResume(state, 1400)).toBe(false);
    expect(msUntilResume(state, 1400)).toBe(state.resumeAt! - 1400);
    expect(canResume(state, state.resumeAt!)).toBe(true);
    expect(msUntilResume(state, state.resumeAt!)).toBe(0);
  });

  test('describePause produces a user-facing message while paused', () => {
    const { state } = recordFailure(initialRateLimitState(), new Error('overloaded (529)'), 1000, 1);
    const message = describePause(state, 1000);
    expect(message).toMatch(/overloaded/);
    expect(message).toMatch(/Resuming automatically/);
    expect(describePause(state, state.resumeAt!)).toBeNull();
  });

  test('recordSuccess clears resilience state', () => {
    const { state } = recordFailure(initialRateLimitState(), new Error('rate limit (429)'), 1000, 0);
    const cleared = recordSuccess(state);
    expect(cleared.consecutiveFailures).toBe(0);
    expect(cleared.resumeAt).toBeNull();
    expect(cleared.lastKind).toBeNull();
  });
});
