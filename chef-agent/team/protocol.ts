/**
 * The team communication protocol.
 *
 * Agents coordinate by emitting tagged directives inside their normal output.
 * The orchestrator parses these directives to advance the shared message bus
 * and task board. Keeping the protocol line-oriented and explicit makes it
 * robust to parse and trivial to unit-test.
 *
 * Supported directives (one per line):
 *   [[team:progress]] <text>
 *   [[team:requirement]] <text>
 *   [[team:notice]] <text>
 *   [[team:recommendation]] <text>
 *   [[team:blocker]] <text>
 *   [[team:handoff:<role>]] <text>
 *   [[team:task:add]] <title> | depends=<id,id> | assignee=<role>
 *   [[team:task:start:<id>]]
 *   [[team:task:done:<id>]]
 *   [[team:task:block:<id>]] <reason>
 *
 * Directives are stripped from user-visible prose by {@link stripDirectives}.
 */
import { AgentMessageBus } from './messageBus.js';
import { TaskBoard } from './taskBoard.js';
import type { AgentRole, TeamMessageKind } from './types.js';

const KNOWN_ROLES: AgentRole[] = [
  'team-head',
  'architect',
  'backend-engineer',
  'frontend-engineer',
  'integration-engineer',
  'security-reviewer',
  'qa-engineer',
];

export type TeamDirective =
  | { type: 'message'; kind: TeamMessageKind; content: string; to?: AgentRole }
  | { type: 'task-add'; title: string; assignee?: AgentRole; dependsOn: string[] }
  | { type: 'task-start'; id: string }
  | { type: 'task-done'; id: string }
  | { type: 'task-block'; id: string; reason: string };

const DIRECTIVE_RE = /\[\[team:([a-z]+)(?::([a-z0-9:_-]+))?\]\]\s*(.*)$/i;

const MESSAGE_KINDS: TeamMessageKind[] = [
  'progress',
  'requirement',
  'notice',
  'recommendation',
  'blocker',
  'handoff',
  'review',
];

function isRole(value: string | undefined): value is AgentRole {
  return value !== undefined && (KNOWN_ROLES as string[]).includes(value);
}

/** Parse all team directives out of a block of agent output. */
export function parseTeamDirectives(text: string): TeamDirective[] {
  const directives: TeamDirective[] = [];
  for (const line of text.split('\n')) {
    const match = DIRECTIVE_RE.exec(line.trim());
    if (!match) {
      continue;
    }
    const verb = match[1].toLowerCase();
    const arg = match[2];
    const rest = match[3]?.trim() ?? '';

    if (verb === 'task') {
      const directive = parseTaskDirective(arg, rest);
      if (directive) {
        directives.push(directive);
      }
      continue;
    }

    if (verb === 'handoff') {
      directives.push({
        type: 'message',
        kind: 'handoff',
        content: rest || 'Handing off the next step.',
        ...(isRole(arg) ? { to: arg } : {}),
      });
      continue;
    }

    if ((MESSAGE_KINDS as string[]).includes(verb) && rest.length > 0) {
      directives.push({ type: 'message', kind: verb as TeamMessageKind, content: rest });
    }
  }
  return directives;
}

function parseTaskDirective(arg: string | undefined, rest: string): TeamDirective | null {
  if (!arg) {
    return null;
  }
  // `arg` may be "add", or carry the id inline, e.g. "done:T3" / "block:T3".
  const segments = arg.split(':');
  const action = segments[0].toLowerCase();
  const inlineId = segments.slice(1).find((s) => /^t\d+$/i.test(s));

  if (action === 'add') {
    return parseTaskAdd(rest);
  }

  const id = (inlineId ?? extractTaskId(rest))?.toUpperCase();
  if (!id) {
    return null;
  }
  if (action === 'start') {
    return { type: 'task-start', id };
  }
  if (action === 'done') {
    return { type: 'task-done', id };
  }
  if (action === 'block') {
    const reason = rest.replace(new RegExp(`^${id}\\b`, 'i'), '').trim();
    return { type: 'task-block', id, reason: reason || 'blocked' };
  }
  return null;
}

function extractTaskId(rest: string): string | null {
  const fromRest = /\b(t\d+)\b/i.exec(rest);
  return fromRest ? fromRest[1].toUpperCase() : null;
}

function parseTaskAdd(rest: string): TeamDirective | null {
  if (!rest) {
    return null;
  }
  const parts = rest.split('|').map((p) => p.trim());
  const title = parts[0];
  if (!title) {
    return null;
  }
  let assignee: AgentRole | undefined;
  const dependsOn: string[] = [];
  for (const part of parts.slice(1)) {
    const [keyRaw, valueRaw] = part.split('=');
    const key = keyRaw?.trim().toLowerCase();
    const value = valueRaw?.trim();
    if (!key || !value) {
      continue;
    }
    if (key === 'assignee' && isRole(value)) {
      assignee = value;
    } else if (key === 'depends' || key === 'dependson' || key === 'after') {
      for (const dep of value.split(/[\s,]+/)) {
        const m = /^t\d+$/i.exec(dep.trim());
        if (m) {
          dependsOn.push(dep.trim().toUpperCase());
        }
      }
    }
  }
  return { type: 'task-add', title, assignee, dependsOn };
}

/** Remove directive lines from text so only prose remains for the user. */
export function stripDirectives(text: string): string {
  return text
    .split('\n')
    .filter((line) => !DIRECTIVE_RE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ApplyResult {
  /** Number of messages posted to the bus. */
  messagesPosted: number;
  /** Number of task mutations applied. */
  tasksChanged: number;
}

/**
 * Apply parsed directives to the shared bus and board. `fromRole` is the agent
 * that authored the output. Returns counts for telemetry/feedback.
 */
export function applyDirectives(
  directives: TeamDirective[],
  bus: AgentMessageBus,
  board: TaskBoard,
  fromRole: AgentRole,
): ApplyResult {
  let messagesPosted = 0;
  let tasksChanged = 0;

  for (const directive of directives) {
    switch (directive.type) {
      case 'message': {
        bus.post({
          from: fromRole,
          kind: directive.kind,
          content: directive.content,
          ...(directive.to ? { to: directive.to } : {}),
        });
        messagesPosted++;
        break;
      }
      case 'task-add': {
        board.add({
          title: directive.title,
          assignee: directive.assignee ?? fromRole,
          dependsOn: directive.dependsOn,
          seq: bus.cursor,
        });
        tasksChanged++;
        break;
      }
      case 'task-start': {
        if (board.setStatus(directive.id, 'in-progress', bus.cursor)) {
          tasksChanged++;
        }
        break;
      }
      case 'task-done': {
        if (board.setStatus(directive.id, 'done', bus.cursor)) {
          tasksChanged++;
        }
        break;
      }
      case 'task-block': {
        if (board.setStatus(directive.id, 'blocked', bus.cursor, directive.reason)) {
          bus.post({
            from: fromRole,
            kind: 'blocker',
            content: `${directive.id}: ${directive.reason}`,
            refs: [directive.id],
          });
          messagesPosted++;
          tasksChanged++;
        }
        break;
      }
    }
  }

  return { messagesPosted, tasksChanged };
}

/** Instructions describing the protocol, injected into every agent's prompt. */
export function teamProtocolInstructions(): string {
  return `## Team coordination protocol

You are one member of a coordinated agent team. Communicate with your teammates
and the Team Head by adding tagged directive lines anywhere in your response.
These lines are parsed by the orchestrator and removed before the user sees them.

Use them to keep the shared task board and message bus up to date:
- [[team:progress]] <what you just accomplished>
- [[team:requirement]] <a requirement teammates must satisfy>
- [[team:notice]] <a heads-up for the team>
- [[team:recommendation]] <a suggestion for how to proceed>
- [[team:blocker]] <something preventing progress>
- [[team:handoff:<role>]] <what the next agent should pick up>
- [[team:task:add]] <title> | assignee=<role> | depends=<T1,T2>
- [[team:task:start:<id>]]
- [[team:task:done:<id>]]
- [[team:task:block:<id>]] <reason>

Valid roles: architect, backend-engineer, frontend-engineer,
integration-engineer, security-reviewer, qa-engineer, team-head.

Always mark a task done when you complete it, and add a brief progress note so
the Team Head can track the build. Keep directives concise.`;
}
