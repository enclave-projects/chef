/**
 * The Agent Team Coordinator.
 *
 * This is the orchestration state machine that ties the team together. It:
 *  - assembles the team and seeds the board/bus,
 *  - selects which agent is active each turn (deterministically from state),
 *  - builds that agent's system prompt (persona + shared context),
 *  - ingests the agent's output to advance the bus/board and run Team Head
 *    oversight,
 *  - tracks rate-limit pauses and produces user-facing feedback.
 *
 * Crucially, {@link AgentTeamCoordinator.rebuildFromHistory} reconstructs the
 * full state by replaying the assistant transcript. Because every transition is
 * a pure function of state, the orchestration resumes exactly where it left off
 * after a rate-limit reset, a reconnect, or a fresh server invocation — no
 * server-side session storage required.
 */
import { AgentMessageBus } from './messageBus.js';
import { TaskBoard } from './taskBoard.js';
import { assembleTeam } from './roleAssignment.js';
import { applyDirectives, parseTeamDirectives, stripDirectives, teamProtocolInstructions } from './protocol.js';
import { buildPersonaPrompt } from './personas.js';
import { reviewTurn } from './teamHead.js';
import {
  canResume,
  describePause,
  initialRateLimitState,
  msUntilResume,
  recordFailure,
  recordSuccess,
} from './rateLimit.js';
import type {
  AgentMember,
  AgentRole,
  AgentTeamState,
  HeadReview,
  RateLimitState,
  TeamComposition,
  TeamFeedback,
  TeamMessage,
  TeamMessageKind,
  TeamPhase,
} from './types.js';

/** How many recent bus messages to surface in the prompt transcript. */
const TRANSCRIPT_LIMIT = 12;
/** Kinds surfaced to the user as highlights. */
const HIGHLIGHT_KINDS: TeamMessageKind[] = ['notice', 'recommendation', 'blocker', 'review', 'handoff'];

export interface TeamSignals {
  existingFileCount?: number;
  isFollowUp?: boolean;
  /** Whether the app has been successfully deployed (from tool results). */
  hasDeployed?: boolean;
}

export class AgentTeamCoordinator {
  readonly task: string;
  private composition: TeamComposition;
  private bus: AgentMessageBus;
  private board: TaskBoard;
  private rateLimit: RateLimitState;
  private turnIndex: number;
  private deployHint: boolean;
  private lastReview: HeadReview | null = null;

  private constructor(args: {
    task: string;
    composition: TeamComposition;
    bus: AgentMessageBus;
    board: TaskBoard;
    rateLimit: RateLimitState;
    turnIndex: number;
    deployHint: boolean;
  }) {
    this.task = args.task;
    this.composition = args.composition;
    this.bus = args.bus;
    this.board = args.board;
    this.rateLimit = args.rateLimit;
    this.turnIndex = args.turnIndex;
    this.deployHint = args.deployHint;
  }

  /** Start a fresh team for a task. */
  static start(task: string, signals?: TeamSignals): AgentTeamCoordinator {
    const composition = assembleTeam(task, signals);
    return new AgentTeamCoordinator({
      task,
      composition,
      bus: new AgentMessageBus(),
      board: new TaskBoard(),
      rateLimit: initialRateLimitState(),
      turnIndex: 0,
      deployHint: signals?.hasDeployed ?? false,
    });
  }

  /** Restore from a previously serialized state. */
  static fromState(state: AgentTeamState): AgentTeamCoordinator {
    return new AgentTeamCoordinator({
      task: state.task,
      composition: state.composition,
      bus: AgentMessageBus.deserialize(state.messages),
      board: TaskBoard.deserialize(state.tasks),
      rateLimit: state.rateLimit,
      turnIndex: state.turnIndex,
      deployHint: false,
    });
  }

  /**
   * Rebuild state by replaying prior assistant outputs in order. This is what
   * makes resuming deterministic: given the same transcript, the same team
   * state (and therefore the same next active agent) is always produced.
   */
  static rebuildFromHistory(
    task: string,
    priorAssistantOutputs: string[],
    signals?: TeamSignals,
  ): AgentTeamCoordinator {
    const coordinator = AgentTeamCoordinator.start(task, signals);
    for (const output of priorAssistantOutputs) {
      coordinator.ingestTurnOutput(output);
    }
    return coordinator;
  }

  get composition_(): TeamComposition {
    return this.composition;
  }

  get phase(): TeamPhase {
    if (this.board.size === 0) {
      return 'planning';
    }
    if (this.board.isComplete()) {
      return this.hasDeployed() ? 'complete' : 'reviewing';
    }
    return 'building';
  }

  private hasDeployed(): boolean {
    if (this.deployHint) {
      return true;
    }
    const deployMentioned = this.bus
      .all()
      .some((m) => /deploy/i.test(m.content) && (m.kind === 'progress' || m.kind === 'handoff'));
    const deployTaskDone = this.board.all().some((t) => t.status === 'done' && /deploy/i.test(t.title));
    return deployMentioned || deployTaskDone;
  }

  private hasReviewed(role: AgentRole): boolean {
    return this.bus.all().some((m) => m.from === role);
  }

  private memberFor(role: AgentRole): AgentMember | undefined {
    if (role === 'team-head') {
      return this.composition.head;
    }
    return this.composition.members.find((m) => m.role === role);
  }

  /** Deterministically choose which agent acts this turn. */
  selectActiveRole(): AgentRole {
    const members = this.composition.members;
    const has = (role: AgentRole) => members.some((m) => m.role === role);

    // Planning: the Architect lays out the plan first.
    if (this.board.size === 0) {
      return has('architect') ? 'architect' : (members[0]?.role ?? 'team-head');
    }

    // Wrap-up: all tasks done — route to review/sign-off, then the Team Head.
    if (this.board.isComplete()) {
      if (!this.hasDeployed()) {
        if (has('qa-engineer')) {
          return 'qa-engineer';
        }
        if (has('backend-engineer')) {
          return 'backend-engineer';
        }
      }
      if (has('security-reviewer') && !this.hasReviewed('security-reviewer')) {
        return 'security-reviewer';
      }
      if (has('qa-engineer') && !this.hasReviewed('qa-engineer')) {
        return 'qa-engineer';
      }
      return 'team-head';
    }

    // Building: work the next actionable task; otherwise the Team Head unblocks.
    const next = this.board.nextActionable();
    if (next) {
      return next.assignee;
    }
    return 'team-head';
  }

  activeMember(): AgentMember {
    const role = this.selectActiveRole();
    return this.memberFor(role) ?? this.composition.head;
  }

  /** Build the system prompt for the active agent's turn. */
  buildTurnSystemPrompt(): string {
    const member = this.activeMember();
    const teammates = [this.composition.head, ...this.composition.members].filter((m) => m.role !== member.role);
    const headDirectives = this.currentHeadDirectives();
    return buildPersonaPrompt({
      member,
      teammates,
      taskBoardRender: this.board.render(),
      recentTranscript: this.bus.transcript(TRANSCRIPT_LIMIT),
      headDirectives,
      protocolInstructions: teamProtocolInstructions(),
    });
  }

  /** The Team Head directives in effect for the upcoming turn. */
  private currentHeadDirectives(): string[] {
    // Pull the most recent head review/recommendation messages off the bus.
    const headMessages = this.bus
      .all()
      .filter((m) => m.from === 'team-head' && (m.kind === 'review' || m.kind === 'recommendation'));
    return headMessages.slice(-4).map((m) => m.content);
  }

  /**
   * Ingest an agent's output: attribute it to the active role, apply its
   * directives, run Team Head oversight, and advance the turn counter.
   */
  ingestTurnOutput(output: string): { headReview: HeadReview; activeRole: AgentRole } {
    const activeRole = this.selectActiveRole();
    const directives = parseTeamDirectives(output);
    applyDirectives(directives, this.bus, this.board, activeRole);

    // Team Head oversight runs every turn (deterministic, no extra model call).
    const review = reviewTurn({
      task: this.task,
      composition: this.composition,
      board: this.board,
      bus: this.bus,
      lastOutput: stripDirectives(output),
      hasDeployed: this.hasDeployed(),
    });

    // Record the head's directives on the bus so the next agent sees them.
    for (const directive of review.directives) {
      this.bus.post({ from: 'team-head', kind: 'review', content: directive });
    }

    this.lastReview = review;
    this.turnIndex += 1;
    return { headReview: review, activeRole };
  }

  /** Record a failed turn; pauses the team if the failure is a transient throttle. */
  recordFailure(error: unknown, now: number, jitter?: number): { paused: boolean; resumeAt: number | null } {
    const result = recordFailure(this.rateLimit, error, now, jitter);
    this.rateLimit = result.state;
    if (result.paused && result.classification.message) {
      this.bus.post({
        from: 'team-head',
        kind: 'notice',
        content: `Paused (${result.classification.kind}). The team will resume automatically once the limit resets.`,
      });
    }
    return { paused: result.paused, resumeAt: this.rateLimit.resumeAt };
  }

  /** Clear resilience state after a successful turn. */
  recordSuccess(): void {
    this.rateLimit = recordSuccess(this.rateLimit);
  }

  isPaused(now: number): boolean {
    return !canResume(this.rateLimit, now);
  }

  /** Produce the compact, user-facing feedback snapshot. */
  feedback(now: number = Date.now()): TeamFeedback {
    const active = this.activeMember();
    const summary = this.board.summary();
    const highlights = this.bus
      .all()
      .filter((m) => HIGHLIGHT_KINDS.includes(m.kind))
      .slice(-5)
      .map((m: TeamMessage) => ({ kind: m.kind, from: m.from, content: m.content }));

    const paused =
      this.rateLimit.resumeAt !== null && !canResume(this.rateLimit, now)
        ? {
            kind: this.rateLimit.lastKind ?? 'rate-limit',
            resumeAt: this.rateLimit.resumeAt,
            message: describePause(this.rateLimit, now) ?? 'Paused; resuming shortly.',
          }
        : null;

    return {
      complexity: this.composition.complexity,
      phase: this.phase,
      turnIndex: this.turnIndex,
      activeAgent: { role: active.role, title: active.title },
      team: [this.composition.head, ...this.composition.members].map((m) => ({ role: m.role, title: m.title })),
      taskSummary: {
        total: summary.total,
        done: summary.done,
        inProgress: summary.inProgress,
        blocked: summary.blocked,
        pending: summary.pending,
      },
      highlights,
      headReview: this.lastReview,
      paused,
    };
  }

  /** Milliseconds until the team may resume (0 if not paused). */
  msUntilResume(now: number = Date.now()): number {
    return msUntilResume(this.rateLimit, now);
  }

  /** Serialize the full state for persistence/telemetry. */
  toState(): AgentTeamState {
    return {
      task: this.task,
      composition: this.composition,
      phase: this.phase,
      turnIndex: this.turnIndex,
      activeRole: this.selectActiveRole(),
      messages: this.bus.serialize(),
      tasks: this.board.serialize(),
      rateLimit: this.rateLimit,
    };
  }
}
