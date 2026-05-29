import { describe, expect, test } from 'vitest';
import { AgentTeamCoordinator } from './coordinator.js';

const COMPLEX_TASK = `Build a Slack clone with:
- channels and direct messages
- user authentication and login
- file upload to storage for avatars
- search across messages`;

const ARCHITECT_TURN = [
  'Here is the plan.',
  '[[team:task:add]] Define Convex schema | assignee=backend-engineer',
  '[[team:task:add]] Build channel + message UI | assignee=frontend-engineer | depends=T1',
  '[[team:progress]] initial plan ready',
  '[[team:handoff:backend-engineer]] start on the schema',
].join('\n');

const BACKEND_TURN = [
  '[[team:task:start:T1]]',
  '[[team:progress]] wrote schema, queries, and mutations with validators',
  '[[team:task:done:T1]]',
  '[[team:handoff:frontend-engineer]] schema is ready',
].join('\n');

describe('AgentTeamCoordinator', () => {
  test('starts a trivial task with a lean team and an engineer active', () => {
    const team = AgentTeamCoordinator.start('Add a counter button');
    expect(team.composition_.complexity).toBe('trivial');
    expect(team.selectActiveRole()).toBe('backend-engineer');
    expect(team.phase).toBe('planning');
  });

  test('starts a complex task with the Architect planning first', () => {
    const team = AgentTeamCoordinator.start(COMPLEX_TASK);
    expect(team.composition_.complexity).not.toBe('trivial');
    expect(team.selectActiveRole()).toBe('architect');
  });

  test('advances through the workflow as turns are ingested', () => {
    const team = AgentTeamCoordinator.start(COMPLEX_TASK);

    // Architect plans -> tasks land on the board, work begins.
    team.ingestTurnOutput(ARCHITECT_TURN);
    expect(team.phase).toBe('building');
    expect(team.selectActiveRole()).toBe('backend-engineer');

    // Backend finishes T1 -> the dependent frontend task becomes actionable.
    team.ingestTurnOutput(BACKEND_TURN);
    expect(team.selectActiveRole()).toBe('frontend-engineer');

    const feedback = team.feedback();
    expect(feedback.taskSummary.total).toBe(2);
    expect(feedback.taskSummary.done).toBe(1);
    expect(feedback.team.some((m) => m.role === 'team-head')).toBe(true);
  });

  test('rebuildFromHistory is deterministic (so it resumes exactly)', () => {
    const a = AgentTeamCoordinator.rebuildFromHistory(COMPLEX_TASK, [ARCHITECT_TURN, BACKEND_TURN]);
    const b = AgentTeamCoordinator.rebuildFromHistory(COMPLEX_TASK, [ARCHITECT_TURN, BACKEND_TURN]);
    expect(JSON.stringify(a.toState())).toEqual(JSON.stringify(b.toState()));
    // And it lands in the same place a live run would.
    expect(a.toState().activeRole).toBe('frontend-engineer');
  });

  test('builds a persona prompt with shared context for the active agent', () => {
    const team = AgentTeamCoordinator.start(COMPLEX_TASK);
    team.ingestTurnOutput(ARCHITECT_TURN);
    const prompt = team.buildTurnSystemPrompt();
    expect(prompt).toContain('Backend Engineer');
    expect(prompt).toContain('Team coordination protocol');
    expect(prompt).toContain('Current task board');
    expect(prompt).toContain('T1');
  });

  test('pauses on a rate-limit failure and reports resume timing', () => {
    const team = AgentTeamCoordinator.start(COMPLEX_TASK);
    const now = 10_000;
    const { paused, resumeAt } = team.recordFailure(new Error('rate limit (429)'), now, 0);
    expect(paused).toBe(true);
    expect(resumeAt).toBe(now + 500);

    expect(team.isPaused(now)).toBe(true);
    expect(team.isPaused(resumeAt!)).toBe(false);

    const feedback = team.feedback(now);
    expect(feedback.paused).not.toBeNull();
    expect(feedback.paused?.kind).toBe('rate-limit');

    // Once the window passes, the team is no longer paused.
    expect(team.feedback(resumeAt!).paused).toBeNull();
  });

  test('an auth failure does not pause the team', () => {
    const team = AgentTeamCoordinator.start(COMPLEX_TASK);
    const { paused } = team.recordFailure(new Error('Invalid API key'), 1000, 0);
    expect(paused).toBe(false);
    expect(team.isPaused(1000)).toBe(false);
  });

  test('the Team Head flags an all-done-but-not-deployed final result', () => {
    const team = AgentTeamCoordinator.start(COMPLEX_TASK);
    team.ingestTurnOutput(ARCHITECT_TURN);
    team.ingestTurnOutput(BACKEND_TURN);
    // Finish the remaining task without ever deploying.
    const { headReview } = team.ingestTurnOutput('[[team:task:done:T2]]\n[[team:progress]] UI complete');
    expect(headReview.concerns.some((c) => c.category === 'final-result')).toBe(true);
    expect(headReview.approved).toBe(false);
  });
});
