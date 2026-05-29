import { memo } from 'react';
import { CheckCircledIcon, ClockIcon, ExclamationTriangleIcon, PersonIcon } from '@radix-ui/react-icons';
import type { TeamFeedback, TeamMessageKind } from 'chef-agent/team/types';
import { classNames } from '~/utils/classNames';

/**
 * Compact, user-facing view of the Agent Orchestrator team's activity for a
 * given assistant turn. Rendered from the `team` message annotation.
 */
export const TeamActivity = memo(function TeamActivity({ feedback }: { feedback: TeamFeedback }) {
  const { taskSummary, activeAgent, team, phase, complexity, highlights, headReview, paused } = feedback;
  const percent = taskSummary.total > 0 ? Math.round((taskSummary.done / taskSummary.total) * 100) : 0;

  return (
    <div className="my-2 rounded-lg border bg-bolt-elements-background-depth-2 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-content-primary">Agent Team</span>
        <Badge>{complexity}</Badge>
        <Badge>{phase}</Badge>
        <span className="flex items-center gap-1 text-content-secondary">
          <PersonIcon className="size-3" />
          {activeAgent.title} active
        </span>
      </div>

      {/* Roster */}
      <div className="mb-2 flex flex-wrap gap-1">
        {team.map((member) => (
          <span
            key={member.role}
            className={classNames(
              'rounded px-1.5 py-0.5',
              member.role === activeAgent.role
                ? 'bg-bolt-elements-item-backgroundAccent text-content-primary'
                : 'bg-bolt-elements-background-depth-3 text-content-secondary',
            )}
            title={member.role}
          >
            {member.title}
          </span>
        ))}
      </div>

      {/* Task progress */}
      {taskSummary.total > 0 && (
        <div className="mb-2">
          <div className="mb-1 flex items-center justify-between text-content-secondary">
            <span>
              Tasks: {taskSummary.done}/{taskSummary.total} done
              {taskSummary.inProgress > 0 ? `, ${taskSummary.inProgress} in progress` : ''}
              {taskSummary.blocked > 0 ? `, ${taskSummary.blocked} blocked` : ''}
            </span>
            <span>{percent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded bg-bolt-elements-background-depth-3">
            <div className="h-full rounded bg-util-success" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}

      {/* Paused (rate-limit) banner */}
      {paused && (
        <div className="mb-2 flex items-center gap-1.5 rounded bg-bolt-elements-background-depth-3 px-2 py-1 text-content-secondary">
          <ClockIcon className="size-3 shrink-0" />
          <span>{paused.message}</span>
        </div>
      )}

      {/* Team Head review */}
      {headReview && (
        <div className="mb-2 flex items-start gap-1.5 text-content-secondary">
          {headReview.approved ? (
            <CheckCircledIcon className="mt-0.5 size-3 shrink-0 text-util-success" />
          ) : (
            <ExclamationTriangleIcon className="mt-0.5 size-3 shrink-0 text-util-warning" />
          )}
          <span>
            Team Head review: quality {headReview.qualityScore}/100
            {headReview.concerns.length > 0 ? ` · ${headReview.concerns.length} concern(s)` : ' · no concerns'}
          </span>
        </div>
      )}

      {/* Recent team messages */}
      {highlights.length > 0 && (
        <ul className="flex flex-col gap-1 text-content-secondary">
          {highlights.map((h, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="shrink-0 font-medium">{kindLabel(h.kind)}:</span>
              <span className="min-w-0 break-words">{h.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-bolt-elements-background-depth-3 px-1.5 py-0.5 capitalize text-content-secondary">
      {children}
    </span>
  );
}

function kindLabel(kind: TeamMessageKind): string {
  switch (kind) {
    case 'recommendation':
      return 'Recommends';
    case 'blocker':
      return 'Blocker';
    case 'notice':
      return 'Notice';
    case 'review':
      return 'Head';
    case 'handoff':
      return 'Handoff';
    case 'requirement':
      return 'Requirement';
    case 'progress':
      return 'Progress';
    default:
      return kind;
  }
}
