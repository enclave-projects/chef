/**
 * Team Head oversight.
 *
 * After an agent's turn, the Team Head reviews the build against four lenses:
 * progress, code quality, security, and the final result. The review is a
 * heuristic, deterministic pass over the shared state plus the latest output —
 * it does not require an extra model call, which keeps oversight cheap and
 * testable. The resulting directives are injected into the next agent's prompt.
 */
import type { AgentMessageBus } from './messageBus.js';
import type { TaskBoard } from './taskBoard.js';
import type { Concern, HeadReview, TeamComposition } from './types.js';

export interface ReviewInput {
  task: string;
  composition: TeamComposition;
  board: TaskBoard;
  bus: AgentMessageBus;
  /** The (directive-stripped) prose the active agent just produced. */
  lastOutput: string;
  /** Whether the build has reached a deploy. */
  hasDeployed: boolean;
}

// Risky code patterns the Team Head flags for quality/security follow-up.
const QUALITY_FLAGS: { pattern: RegExp; message: string }[] = [
  { pattern: /:\s*any\b/, message: 'Avoid `any` types; prefer precise types or validators.' },
  { pattern: /\/\/\s*todo|\bfixme\b/i, message: 'Unfinished TODO/FIXME left in the code.' },
  { pattern: /console\.log\(/, message: 'Stray console.log left in the code.' },
];

const SECURITY_FLAGS: { pattern: RegExp; message: string }[] = [
  {
    pattern: /process\.env\.[A-Z_]+/,
    message: 'Referencing secrets directly — ensure they are only read server-side and never exposed to the client.',
  },
  {
    pattern: /dangerouslySetInnerHTML/,
    message: 'dangerouslySetInnerHTML can introduce XSS; sanitize or avoid it.',
  },
];

const SECURITY_TASK_KEYWORDS = ['auth', 'login', 'permission', 'private', 'admin', 'payment', 'role', 'access'];

export function reviewTurn(input: ReviewInput): HeadReview {
  const concerns: Concern[] = [];
  const directives: string[] = [];

  const summary = input.board.summary();
  const output = input.lastOutput ?? '';

  // --- Progress -----------------------------------------------------------
  if (summary.total === 0) {
    concerns.push({
      category: 'progress',
      severity: 'warning',
      message: 'No tasks on the board yet — the Architect should produce a task plan first.',
    });
    directives.push('Start by adding a concrete task plan with [[team:task:add]] directives.');
  } else if (summary.blocked > 0) {
    concerns.push({
      category: 'progress',
      severity: 'warning',
      message: `${summary.blocked} task(s) are blocked and need attention.`,
    });
    directives.push('Resolve blocked tasks or re-plan around them before adding new work.');
  }

  // --- Code quality -------------------------------------------------------
  for (const flag of QUALITY_FLAGS) {
    if (flag.pattern.test(output)) {
      concerns.push({ category: 'code-quality', severity: 'info', message: flag.message });
    }
  }

  // --- Security -----------------------------------------------------------
  const taskLower = input.task.toLowerCase();
  const isSecuritySensitive = SECURITY_TASK_KEYWORDS.some((k) => taskLower.includes(k));
  const hasSecurityReviewer = input.composition.members.some((m) => m.role === 'security-reviewer');
  const securityNoticed =
    input.bus.all().some((m) => m.from === 'security-reviewer') ||
    /access control|validate|authoriz|permission/i.test(output);

  for (const flag of SECURITY_FLAGS) {
    if (flag.pattern.test(output)) {
      concerns.push({ category: 'security', severity: 'warning', message: flag.message });
    }
  }

  if (isSecuritySensitive && hasSecurityReviewer && !securityNoticed && summary.done > 0) {
    concerns.push({
      category: 'security',
      severity: 'warning',
      message: 'Security-sensitive task with no security review recorded yet.',
    });
    directives.push('Have the Security Reviewer audit access control and input validation before finishing.');
  }

  // --- Final result -------------------------------------------------------
  const allTasksDone = summary.total > 0 && input.board.isComplete();
  if (allTasksDone && !input.hasDeployed) {
    concerns.push({
      category: 'final-result',
      severity: 'warning',
      message: 'All tasks are done but the app has not been deployed/verified.',
    });
    directives.push('Deploy the app and verify it runs before declaring the work complete.');
  }

  const qualityScore = scoreQuality(concerns, summary.percentComplete, input.hasDeployed);

  // Approve only when there are no blocking concerns and the work is meaningfully complete.
  const blockingConcerns = concerns.filter((c) => c.severity !== 'info');
  const approved = blockingConcerns.length === 0 && (allTasksDone ? input.hasDeployed : summary.total > 0);

  if (approved && allTasksDone && input.hasDeployed) {
    directives.push('Work meets the bar. Confirm the final result with the user and wrap up.');
  }

  return { approved, concerns, directives, qualityScore };
}

function scoreQuality(concerns: Concern[], percentComplete: number, hasDeployed: boolean): number {
  let score = 60 + Math.round(percentComplete * 0.3); // up to 90 from progress
  if (hasDeployed) {
    score += 10;
  }
  for (const concern of concerns) {
    switch (concern.severity) {
      case 'critical':
        score -= 25;
        break;
      case 'warning':
        score -= 10;
        break;
      case 'info':
        score -= 3;
        break;
    }
  }
  return Math.max(0, Math.min(100, score));
}
