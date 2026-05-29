/**
 * Automatic role assignment.
 *
 * Given a user's task description (and optionally some project signals), this
 * module estimates the complexity of the work and assembles a team of
 * specialized agents to tackle it. It is deliberately deterministic and
 * heuristic (no LLM call) so it is fast, free, and fully unit-testable.
 */
import type { AgentMember, AgentRole, Complexity, TeamComposition } from './types.js';

/** Catalog of every role the orchestrator can recruit. */
export const AGENT_CATALOG: Record<AgentRole, AgentMember> = {
  'team-head': {
    id: 'team-head',
    role: 'team-head',
    title: 'Team Head',
    focus: 'Oversees the whole build: progress, code quality, security, and final result.',
    responsibilities: [
      'Keep the team aligned on the user goal',
      'Review each turn for correctness, quality, and security',
      'Decide when the work meets the bar to deploy and finish',
      'Unblock and re-prioritize the task board',
    ],
  },
  architect: {
    id: 'architect',
    role: 'architect',
    title: 'Architect',
    focus: 'Designs the data model and breaks the work into a concrete task plan.',
    responsibilities: [
      'Define the Convex schema and how data flows',
      'Decompose the request into ordered tasks with clear ownership',
      'Call out cross-cutting requirements early',
    ],
  },
  'backend-engineer': {
    id: 'backend-engineer',
    role: 'backend-engineer',
    title: 'Backend Engineer',
    focus: 'Implements Convex queries, mutations, actions, and the schema.',
    responsibilities: [
      'Write the Convex schema and indexes',
      'Implement queries, mutations, and actions with proper validators',
      'Keep server logic reactive and consistent',
    ],
  },
  'frontend-engineer': {
    id: 'frontend-engineer',
    role: 'frontend-engineer',
    title: 'Frontend Engineer',
    focus: 'Builds the React UI and wires it to Convex.',
    responsibilities: [
      'Build accessible, responsive React components',
      'Wire the UI to Convex queries and mutations',
      'Handle loading, empty, and error states',
    ],
  },
  'integration-engineer': {
    id: 'integration-engineer',
    role: 'integration-engineer',
    title: 'Integration Engineer',
    focus: 'Handles external services, file storage, and third-party APIs.',
    responsibilities: [
      'Integrate file storage, email, payments, or other external APIs',
      'Manage environment variables and secrets safely',
      'Isolate Node-only dependencies into "use node" actions',
    ],
  },
  'security-reviewer': {
    id: 'security-reviewer',
    role: 'security-reviewer',
    title: 'Security Reviewer',
    focus: 'Audits auth, access control, validation, and data exposure.',
    responsibilities: [
      'Verify every query/mutation enforces access control',
      'Check inputs are validated and secrets are never leaked',
      'Flag insecure patterns before they ship',
    ],
  },
  'qa-engineer': {
    id: 'qa-engineer',
    role: 'qa-engineer',
    title: 'QA Engineer',
    focus: 'Verifies the app meets every requirement and deploys cleanly.',
    responsibilities: [
      'Trace each requirement to an implemented feature',
      'Exercise edge cases and error paths',
      'Confirm the app deploys and runs before sign-off',
    ],
  },
};

/** A factor that contributed to the complexity score (useful for explaining). */
export interface ComplexityFactor {
  label: string;
  weight: number;
}

export interface ComplexityAssessment {
  complexity: Complexity;
  score: number;
  factors: ComplexityFactor[];
}

/** Keyword groups that hint at extra complexity or specific specialists. */
const SECURITY_SIGNALS = [
  'auth',
  'authentication',
  'login',
  'sign in',
  'sign up',
  'password',
  'permission',
  'role',
  'access control',
  'admin',
  'private',
  'secure',
  'payment',
  'billing',
  'stripe',
  'token',
  'api key',
  'pii',
  'personal data',
];

const INTEGRATION_SIGNALS = [
  'upload',
  'file',
  'image',
  'photo',
  'storage',
  'email',
  'resend',
  'webhook',
  'stripe',
  'payment',
  'third-party',
  'third party',
  'external api',
  'integrat',
  'oauth',
  'sms',
  'notification',
];

const REALTIME_SIGNALS = ['real-time', 'realtime', 'live', 'collaborat', 'presence', 'multiplayer', 'sync'];

const SCALE_SIGNALS = ['search', 'pagination', 'infinite scroll', 'feed', 'dashboard', 'analytics', 'chart', 'report'];

function countSignals(haystack: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const needle of needles) {
    if (haystack.includes(needle)) {
      found.push(needle);
    }
  }
  return found;
}

/** Count bullet-like lines, a decent proxy for the number of requirements. */
function countRequirements(task: string): number {
  const lines = task.split('\n');
  let bullets = 0;
  for (const line of lines) {
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      bullets++;
    }
  }
  return bullets;
}

/**
 * Estimate the complexity of a task from its description plus optional signals.
 */
export function assessComplexity(
  task: string,
  signals?: { existingFileCount?: number; isFollowUp?: boolean },
): ComplexityAssessment {
  const text = task.toLowerCase();
  const factors: ComplexityFactor[] = [];

  const requirements = countRequirements(task);
  if (requirements > 0) {
    const weight = Math.min(requirements, 10);
    factors.push({ label: `${requirements} explicit requirement(s)`, weight });
  }

  const wordCount = task.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > 60) {
    factors.push({ label: 'long, detailed description', weight: 3 });
  } else if (wordCount > 25) {
    factors.push({ label: 'moderately detailed description', weight: 1 });
  }

  const security = countSignals(text, SECURITY_SIGNALS);
  if (security.length > 0) {
    factors.push({ label: `security-sensitive (${security.length} signal(s))`, weight: 2 + security.length });
  }

  const integration = countSignals(text, INTEGRATION_SIGNALS);
  if (integration.length > 0) {
    factors.push({ label: `external integration (${integration.length} signal(s))`, weight: 2 + integration.length });
  }

  const realtime = countSignals(text, REALTIME_SIGNALS);
  if (realtime.length > 0) {
    factors.push({ label: 'real-time / collaborative', weight: 3 });
  }

  const scale = countSignals(text, SCALE_SIGNALS);
  if (scale.length > 0) {
    factors.push({ label: 'search / data-heavy UI', weight: 2 });
  }

  if (signals?.existingFileCount && signals.existingFileCount > 25) {
    factors.push({ label: 'large existing codebase', weight: 2 });
  }

  const score = factors.reduce((sum, f) => sum + f.weight, 0);

  let complexity: Complexity;
  if (score <= 2) {
    complexity = 'trivial';
  } else if (score <= 6) {
    complexity = 'simple';
  } else if (score <= 12) {
    complexity = 'moderate';
  } else {
    complexity = 'complex';
  }

  return { complexity, score, factors };
}

/** Build a member entry from the catalog (cloned so callers cannot mutate it). */
function member(role: AgentRole): AgentMember {
  const base = AGENT_CATALOG[role];
  return { ...base, responsibilities: [...base.responsibilities] };
}

/**
 * Assemble a team for a task. The Team Head is always present; the set of
 * individual contributors scales with complexity and the detected signals.
 */
export function assembleTeam(
  task: string,
  signals?: { existingFileCount?: number; isFollowUp?: boolean },
): TeamComposition {
  const assessment = assessComplexity(task, signals);
  const text = task.toLowerCase();

  const roles: AgentRole[] = ['architect', 'backend-engineer', 'frontend-engineer'];

  const needsIntegration = countSignals(text, INTEGRATION_SIGNALS).length > 0;
  const needsSecurity = countSignals(text, SECURITY_SIGNALS).length > 0;

  if (needsIntegration && assessment.complexity !== 'trivial') {
    roles.push('integration-engineer');
  }

  // Recruit a dedicated security reviewer when the work touches sensitive areas
  // or whenever the task is complex enough to warrant a second set of eyes.
  if (needsSecurity || assessment.complexity === 'complex') {
    roles.push('security-reviewer');
  }

  // QA joins for anything beyond the simplest builds.
  if (assessment.complexity === 'moderate' || assessment.complexity === 'complex') {
    roles.push('qa-engineer');
  }

  // For trivial tasks keep the team lean: architect doubles as planner and a
  // single engineer does the work.
  let members: AgentMember[];
  if (assessment.complexity === 'trivial') {
    members = [member('backend-engineer'), member('frontend-engineer')];
  } else {
    members = roles.map(member);
  }

  const rationale = buildRationale(assessment, members);

  return {
    complexity: assessment.complexity,
    head: member('team-head'),
    members,
    rationale,
  };
}

function buildRationale(assessment: ComplexityAssessment, members: AgentMember[]): string {
  const roleList = members.map((m) => m.title).join(', ');
  const factorList =
    assessment.factors.length > 0 ? assessment.factors.map((f) => f.label).join('; ') : 'a small, well-scoped request';
  return `Assessed as ${assessment.complexity} (score ${assessment.score}) based on ${factorList}. Recruited: ${roleList}, overseen by the Team Head.`;
}
