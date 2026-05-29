/**
 * Server-side bridge between Chef's streaming agent loop and the Agent
 * Orchestrator team engine (chef-agent/team).
 *
 * The team engine is deterministic and stateless across requests: given the
 * chat transcript it rebuilds the full orchestration state, so we don't need
 * any server-side session storage. On each /api/chat call we:
 *   1. derive the user's overall task and the prior assistant transcript,
 *   2. rebuild the coordinator,
 *   3. inject the active agent's persona/system prompt into the model call,
 *   4. after the turn, ingest the output and emit a `team` feedback annotation.
 */
import type { Message } from 'ai';
import { AgentTeamCoordinator, type TeamSignals } from 'chef-agent/team/index';
import type { TeamFeedback } from 'chef-agent/team/types';

export interface AgentTeamOptions {
  enabled: boolean;
  /** Number of files already in the project (a complexity signal). */
  existingFileCount?: number;
  /** Whether the app has already deployed successfully. */
  hasDeployed?: boolean;
}

/** Extract the user's overall task: the first non-empty user message. */
export function extractTask(messages: Message[]): string {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = messageText(message);
    if (text.trim().length > 0) {
      return text.trim();
    }
  }
  return '';
}

/** Combined text of every assistant message, in order (one entry per message). */
export function extractAssistantOutputs(messages: Message[]): string[] {
  const outputs: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    const text = messageText(message);
    if (text.trim().length > 0) {
      outputs.push(text);
    }
  }
  return outputs;
}

/**
 * Build a coordinator positioned for the upcoming turn by replaying the
 * transcript. Returns null when there is no usable task (so the caller can fall
 * back to the standard single-agent flow).
 */
export function buildTeamCoordinator(messages: Message[], options: AgentTeamOptions): AgentTeamCoordinator | null {
  const task = extractTask(messages);
  if (task.length === 0) {
    return null;
  }
  const signals: TeamSignals = {
    existingFileCount: options.existingFileCount,
    hasDeployed: options.hasDeployed ?? detectHasDeployed(messages),
    isFollowUp: messages.filter((m) => m.role === 'user').length > 1,
  };
  return AgentTeamCoordinator.rebuildFromHistory(task, extractAssistantOutputs(messages), signals);
}

/** Detect a prior successful deploy from assistant tool-invocation results. */
export function detectHasDeployed(messages: Message[]): boolean {
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    for (const part of message.parts ?? []) {
      if (
        part.type === 'tool-invocation' &&
        part.toolInvocation.toolName === 'deploy' &&
        part.toolInvocation.state === 'result' &&
        typeof part.toolInvocation.result === 'string' &&
        !part.toolInvocation.result.startsWith('Error:')
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Serialize a feedback snapshot for the `team` message annotation. */
export function encodeTeamFeedback(feedback: TeamFeedback): { type: 'team'; payload: string } {
  return { type: 'team', payload: JSON.stringify(feedback) };
}

function messageText(message: Message): string {
  const parts = message.parts ?? [];
  const textFromParts = parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  if (textFromParts.trim().length > 0) {
    return textFromParts;
  }
  return message.content ?? '';
}
