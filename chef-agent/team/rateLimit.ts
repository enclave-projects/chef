/**
 * Resilience: rate-limit classification and resume scheduling.
 *
 * Upstream providers surface throttling as HTTP 429 (rate limited) and 529
 * (overloaded). In Chef those are re-thrown as JSON-encoded error strings (see
 * app/lib/.server/llm/provider.ts). This module classifies such errors and
 * computes when the team may resume, so the orchestrator can pause gracefully
 * and pick up exactly where it left off after the limit resets.
 */
import type { RateLimitKind, RateLimitState } from './types.js';

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

export function initialRateLimitState(): RateLimitState {
  return {
    consecutiveFailures: 0,
    resumeAt: null,
    lastKind: null,
    lastMessage: null,
  };
}

export interface ClassifiedError {
  kind: RateLimitKind;
  message: string;
  /** Server-suggested retry delay in ms, if one could be extracted. */
  retryAfterMs: number | null;
}

/**
 * Classify an error thrown during a model call. Accepts an Error, a string, or
 * an object with a numeric `status`/`statusCode`.
 */
export function classifyError(error: unknown): ClassifiedError {
  const raw = extractMessage(error);
  const status = extractStatus(error) ?? extractStatusFromText(raw);
  const lower = raw.toLowerCase();

  let kind: RateLimitKind = 'other';
  if (status === 429 || /rate.?limit|too many requests|quota/.test(lower)) {
    kind = 'rate-limit';
  } else if (status === 529 || /overloaded|temporarily unavailable|capacity/.test(lower)) {
    kind = 'overloaded';
  } else if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden/.test(lower)) {
    kind = 'auth';
  }

  return {
    kind,
    message: raw,
    retryAfterMs: extractRetryAfterMs(error, raw),
  };
}

/** Whether a classification represents a transient throttle we can wait out. */
export function isResumable(kind: RateLimitKind): boolean {
  return kind === 'rate-limit' || kind === 'overloaded';
}

/**
 * Exponential backoff with jitter, capped. `jitter` is injectable for
 * deterministic tests (defaults to Math.random()).
 */
export function backoffMs(consecutiveFailures: number, jitter: number = Math.random()): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const base = Math.min(MIN_BACKOFF_MS * Math.pow(2, exponent), MAX_BACKOFF_MS);
  // Spread jitter across [0.5, 1.5) of the base delay, then re-cap.
  const jittered = base * (0.5 + jitter);
  return Math.min(Math.round(jittered), MAX_BACKOFF_MS);
}

export interface RecordFailureResult {
  state: RateLimitState;
  classification: ClassifiedError;
  /** Whether the team is now paused (i.e. the failure was resumable). */
  paused: boolean;
}

/**
 * Fold a failure into the rate-limit state. On a resumable failure this sets
 * `resumeAt`; on a non-resumable failure it records the message but does not
 * pause. A successful turn should call {@link recordSuccess} to clear state.
 */
export function recordFailure(
  state: RateLimitState,
  error: unknown,
  now: number,
  jitter: number = Math.random(),
): RecordFailureResult {
  const classification = classifyError(error);
  if (!isResumable(classification.kind)) {
    return {
      state: {
        ...state,
        lastKind: classification.kind,
        lastMessage: classification.message,
      },
      classification,
      paused: false,
    };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  const delay = classification.retryAfterMs ?? backoffMs(consecutiveFailures, jitter);
  return {
    state: {
      consecutiveFailures,
      resumeAt: now + delay,
      lastKind: classification.kind,
      lastMessage: classification.message,
    },
    classification,
    paused: true,
  };
}

/** Reset resilience state after a successful turn. */
export function recordSuccess(state: RateLimitState): RateLimitState {
  if (state.consecutiveFailures === 0 && state.resumeAt === null && state.lastKind === null) {
    return state;
  }
  return initialRateLimitState();
}

/** Whether the team may resume given the current time. */
export function canResume(state: RateLimitState, now: number): boolean {
  if (state.resumeAt === null) {
    return true;
  }
  return now >= state.resumeAt;
}

/** Milliseconds remaining until resume (0 if resumable now). */
export function msUntilResume(state: RateLimitState, now: number): number {
  if (state.resumeAt === null) {
    return 0;
  }
  return Math.max(0, state.resumeAt - now);
}

/** A user-facing description of the current pause. */
export function describePause(state: RateLimitState, now: number): string | null {
  if (state.resumeAt === null || canResume(state, now)) {
    return null;
  }
  const seconds = Math.ceil(msUntilResume(state, now) / 1000);
  const reason =
    state.lastKind === 'overloaded' ? 'the model is temporarily overloaded' : 'we hit the model rate limit';
  return `Paused because ${reason}. Resuming automatically in ~${seconds}s.`;
}

function extractMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    const maybe = error as { message?: unknown; error?: unknown };
    if (typeof maybe.message === 'string') {
      return maybe.message;
    }
    if (typeof maybe.error === 'string') {
      return maybe.error;
    }
  }
  return String(error);
}

function extractStatus(error: unknown): number | null {
  if (error && typeof error === 'object') {
    const maybe = error as { status?: unknown; statusCode?: unknown };
    if (typeof maybe.status === 'number') {
      return maybe.status;
    }
    if (typeof maybe.statusCode === 'number') {
      return maybe.statusCode;
    }
  }
  return null;
}

function extractStatusFromText(text: string): number | null {
  const match = /\b(429|529|401|403)\b/.exec(text);
  return match ? parseInt(match[1], 10) : null;
}

function extractRetryAfterMs(error: unknown, text: string): number | null {
  // Honour an explicit numeric retry-after if present (header-like or in text).
  if (error && typeof error === 'object') {
    const maybe = error as { retryAfterMs?: unknown; retryAfter?: unknown };
    if (typeof maybe.retryAfterMs === 'number') {
      return maybe.retryAfterMs;
    }
    if (typeof maybe.retryAfter === 'number') {
      return maybe.retryAfter * 1000;
    }
  }
  const match = /retry[- ]?after["':\s]+(\d+)/i.exec(text);
  if (match) {
    return parseInt(match[1], 10) * 1000;
  }
  return null;
}
