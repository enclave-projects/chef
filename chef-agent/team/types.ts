/**
 * Core type definitions for the Agent Orchestrator team feature.
 *
 * The Agent Orchestrator deploys a *team* of specialized agents (peers, not
 * sub-agents) coordinated by a Team Head. Each agent owns a role, the team
 * shares a message bus and task board, and the Team Head oversees progress,
 * code quality, security, and the final result.
 *
 * Everything in this module is pure, serializable data so the orchestration
 * state can be rebuilt deterministically from chat history (which is what makes
 * resuming after a rate-limit reset automatic).
 */

/**
 * How involved a task is. Drives how large the team is and which specialists
 * are recruited.
 */
export type Complexity = 'trivial' | 'simple' | 'moderate' | 'complex';

/**
 * The roles an agent can play. `team-head` is the overseer; the rest are
 * individual contributors.
 */
export type AgentRole =
  | 'team-head'
  | 'architect'
  | 'backend-engineer'
  | 'frontend-engineer'
  | 'integration-engineer'
  | 'security-reviewer'
  | 'qa-engineer';

/** A single member of the agent team. */
export interface AgentMember {
  /** Stable identifier, equal to the role for now (one agent per role). */
  id: AgentRole;
  role: AgentRole;
  /** Human-friendly title shown to the user. */
  title: string;
  /** Short, user-facing description of what this agent focuses on. */
  focus: string;
  /** Concrete responsibilities used both for prompting and oversight. */
  responsibilities: string[];
}

/** The assembled team for a task. */
export interface TeamComposition {
  complexity: Complexity;
  /** The overseer. Always present. */
  head: AgentMember;
  /** Individual contributors, excluding the head. Ordered by typical workflow. */
  members: AgentMember[];
  /** Human-readable explanation of why this team was assembled. */
  rationale: string;
}

/** Kinds of messages agents post to the shared bus. */
export type TeamMessageKind =
  | 'progress' // "I finished wiring the schema"
  | 'requirement' // "We need a `messages` table with an index on channelId"
  | 'notice' // "Heads up: the deploy tool is failing with esbuild errors"
  | 'recommendation' // "I recommend validating the upload size on the server"
  | 'handoff' // "Backend done, handing off to frontend"
  | 'review' // posted by the Team Head after reviewing a turn
  | 'blocker'; // "Blocked: need the Convex deployment name before continuing"

/** A message shared between agents. */
export interface TeamMessage {
  /** Monotonic sequence number assigned by the bus. */
  seq: number;
  /** Author role. */
  from: AgentRole;
  /** Recipient role, or `all` for a broadcast. */
  to: AgentRole | 'all';
  kind: TeamMessageKind;
  content: string;
  /** Optional task ids this message refers to. */
  refs?: string[];
}

/** Lifecycle of a task on the board. */
export type TaskStatus = 'pending' | 'in-progress' | 'blocked' | 'done' | 'cancelled';

/** A unit of work tracked on the shared task board. */
export interface Task {
  id: string;
  title: string;
  /** Role responsible for the task. */
  assignee: AgentRole;
  status: TaskStatus;
  /** Ids of tasks that must be `done` before this one can start. */
  dependsOn: string[];
  /** Free-form notes (e.g. why it is blocked). */
  notes?: string;
  /** Bus sequence when the task was created / last updated. */
  createdSeq: number;
  updatedSeq: number;
}

/** Categories the Team Head reviews against. */
export type ConcernCategory = 'code-quality' | 'security' | 'progress' | 'requirements' | 'final-result';

export type ConcernSeverity = 'info' | 'warning' | 'critical';

/** A single issue raised by the Team Head. */
export interface Concern {
  category: ConcernCategory;
  severity: ConcernSeverity;
  message: string;
}

/** The Team Head's verdict on a turn. */
export interface HeadReview {
  /** Whether the work so far meets the bar to keep going / finish. */
  approved: boolean;
  concerns: Concern[];
  /** Actionable instructions injected into the next agent's prompt. */
  directives: string[];
  /** 0-100 heuristic quality score. */
  qualityScore: number;
}

/** How an upstream error was classified for resilience handling. */
export type RateLimitKind = 'rate-limit' | 'overloaded' | 'auth' | 'other';

/** Persisted resilience state so the team can pause and resume. */
export interface RateLimitState {
  /** Number of consecutive rate-limit/overload failures. */
  consecutiveFailures: number;
  /** Epoch millis when the team may resume, or null if not paused. */
  resumeAt: number | null;
  /** The classification of the most recent failure, if any. */
  lastKind: RateLimitKind | null;
  /** Human-readable description of the most recent failure. */
  lastMessage: string | null;
}

/** Coarse phase of the build, used to schedule which agent is active. */
export type TeamPhase = 'planning' | 'building' | 'reviewing' | 'complete';

/** The full, serializable orchestration state. */
export interface AgentTeamState {
  /** The original user task that seeded the team. */
  task: string;
  composition: TeamComposition;
  phase: TeamPhase;
  /** Zero-based index of the current turn. */
  turnIndex: number;
  /** Role active for the current turn. */
  activeRole: AgentRole;
  /** Serialized message bus. */
  messages: TeamMessage[];
  /** Serialized task board. */
  tasks: Task[];
  rateLimit: RateLimitState;
}

/** Compact, user-facing snapshot emitted as a message annotation. */
export interface TeamFeedback {
  complexity: Complexity;
  phase: TeamPhase;
  turnIndex: number;
  /** The agent that just worked. */
  activeAgent: { role: AgentRole; title: string };
  team: { role: AgentRole; title: string }[];
  taskSummary: {
    total: number;
    done: number;
    inProgress: number;
    blocked: number;
    pending: number;
  };
  /** Most recent notices/recommendations/blockers for the user. */
  highlights: { kind: TeamMessageKind; from: AgentRole; content: string }[];
  /** Team Head's latest review, if one ran this turn. */
  headReview: HeadReview | null;
  /** Populated when the team is paused waiting for a rate limit to reset. */
  paused: {
    kind: RateLimitKind;
    resumeAt: number;
    message: string;
  } | null;
}
