/**
 * Agent Orchestrator — team mode.
 *
 * Public surface for deploying a coordinated team of specialized agents
 * (peers, not sub-agents) with automatic role assignment, inter-agent
 * communication, a Team Head overseer, and graceful resilience.
 *
 * Typical usage on the server (see app/lib/.server/llm/agent-team.ts):
 *
 *   const team = AgentTeamCoordinator.rebuildFromHistory(task, priorOutputs, signals);
 *   const systemPrompt = team.buildTurnSystemPrompt();
 *   // ...run the model with `systemPrompt` injected...
 *   const { headReview } = team.ingestTurnOutput(modelOutput);
 *   const feedback = team.feedback();
 */
export * from './types.js';
export { AGENT_CATALOG, assembleTeam, assessComplexity } from './roleAssignment.js';
export type { ComplexityAssessment, ComplexityFactor } from './roleAssignment.js';
export { AgentMessageBus, formatMessage, roleLabel } from './messageBus.js';
export type { PostOptions } from './messageBus.js';
export { TaskBoard } from './taskBoard.js';
export type { AddTaskOptions, TaskSummary } from './taskBoard.js';
export {
  classifyError,
  isResumable,
  backoffMs,
  recordFailure,
  recordSuccess,
  canResume,
  msUntilResume,
  describePause,
  initialRateLimitState,
} from './rateLimit.js';
export type { ClassifiedError, RecordFailureResult } from './rateLimit.js';
export { parseTeamDirectives, applyDirectives, stripDirectives, teamProtocolInstructions } from './protocol.js';
export type { TeamDirective, ApplyResult } from './protocol.js';
export { buildPersonaPrompt, personaTitle } from './personas.js';
export { reviewTurn } from './teamHead.js';
export type { ReviewInput } from './teamHead.js';
export { AgentTeamCoordinator } from './coordinator.js';
export type { TeamSignals } from './coordinator.js';
