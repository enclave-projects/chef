/**
 * Inter-agent communication.
 *
 * The AgentMessageBus is the shared channel team members use to share progress,
 * requirements, notices, recommendations, hand-offs, blockers, and the Team
 * Head's reviews. It assigns a monotonic sequence number to every message so
 * the transcript is totally ordered and can be replayed/resumed deterministically.
 */
import type { AgentRole, TeamMessage, TeamMessageKind } from './types.js';

export interface PostOptions {
  from: AgentRole;
  kind: TeamMessageKind;
  content: string;
  /** Defaults to a broadcast (`all`). */
  to?: AgentRole | 'all';
  refs?: string[];
}

export class AgentMessageBus {
  private messages: TeamMessage[];
  private nextSeq: number;

  constructor(initial: TeamMessage[] = []) {
    this.messages = [...initial];
    this.nextSeq = initial.reduce((max, m) => Math.max(max, m.seq + 1), 0);
  }

  /** Current sequence number that will be assigned to the next message. */
  get cursor(): number {
    return this.nextSeq;
  }

  get size(): number {
    return this.messages.length;
  }

  /** Post a message and return the stored record (with its assigned seq). */
  post(options: PostOptions): TeamMessage {
    const trimmed = options.content.trim();
    if (trimmed.length === 0) {
      throw new Error('Cannot post an empty team message');
    }
    const message: TeamMessage = {
      seq: this.nextSeq++,
      from: options.from,
      to: options.to ?? 'all',
      kind: options.kind,
      content: trimmed,
      ...(options.refs && options.refs.length > 0 ? { refs: [...options.refs] } : {}),
    };
    this.messages.push(message);
    return message;
  }

  /** All messages in order. */
  all(): TeamMessage[] {
    return [...this.messages];
  }

  /** Messages visible to a role: broadcasts plus anything addressed to it. */
  messagesFor(role: AgentRole): TeamMessage[] {
    return this.messages.filter((m) => m.to === 'all' || m.to === role || m.from === role);
  }

  /** Messages of a given kind. */
  byKind(kind: TeamMessageKind): TeamMessage[] {
    return this.messages.filter((m) => m.kind === kind);
  }

  /** Messages posted at or after a given sequence number. */
  since(seq: number): TeamMessage[] {
    return this.messages.filter((m) => m.seq >= seq);
  }

  /** The most recent `count` messages, oldest-first. */
  recent(count: number): TeamMessage[] {
    if (count <= 0) {
      return [];
    }
    return this.messages.slice(-count);
  }

  /**
   * A compact, human-readable transcript suitable for injecting into a prompt
   * or showing the user.
   */
  transcript(limit?: number): string {
    const slice = limit ? this.recent(limit) : this.messages;
    return slice.map((m) => formatMessage(m)).join('\n');
  }

  /** Serialize to plain data (already plain, but copied to be safe). */
  serialize(): TeamMessage[] {
    return this.all();
  }

  static deserialize(messages: TeamMessage[]): AgentMessageBus {
    return new AgentMessageBus(messages);
  }
}

const ROLE_LABELS: Record<AgentRole, string> = {
  'team-head': 'Team Head',
  architect: 'Architect',
  'backend-engineer': 'Backend Engineer',
  'frontend-engineer': 'Frontend Engineer',
  'integration-engineer': 'Integration Engineer',
  'security-reviewer': 'Security Reviewer',
  'qa-engineer': 'QA Engineer',
};

export function roleLabel(role: AgentRole): string {
  return ROLE_LABELS[role];
}

export function formatMessage(message: TeamMessage): string {
  const to = message.to === 'all' ? '' : ` → ${ROLE_LABELS[message.to]}`;
  const refs = message.refs && message.refs.length > 0 ? ` (re: ${message.refs.join(', ')})` : '';
  return `[${message.seq}] ${ROLE_LABELS[message.from]}${to} · ${message.kind}: ${message.content}${refs}`;
}
