import { describe, expect, test } from 'vitest';
import { AgentMessageBus } from './messageBus.js';
import { TaskBoard } from './taskBoard.js';
import { applyDirectives, parseTeamDirectives, stripDirectives } from './protocol.js';

describe('parseTeamDirectives', () => {
  test('parses message directives', () => {
    const directives = parseTeamDirectives(
      [
        '[[team:progress]] wired up the schema',
        '[[team:recommendation]] validate uploads on the server',
        '[[team:blocker]] need the deployment name',
      ].join('\n'),
    );
    expect(directives).toEqual([
      { type: 'message', kind: 'progress', content: 'wired up the schema' },
      { type: 'message', kind: 'recommendation', content: 'validate uploads on the server' },
      { type: 'message', kind: 'blocker', content: 'need the deployment name' },
    ]);
  });

  test('parses a handoff with a target role', () => {
    const [directive] = parseTeamDirectives('[[team:handoff:frontend-engineer]] build the message list');
    expect(directive).toEqual({
      type: 'message',
      kind: 'handoff',
      content: 'build the message list',
      to: 'frontend-engineer',
    });
  });

  test('parses task add with assignee and dependencies', () => {
    const [directive] = parseTeamDirectives(
      '[[team:task:add]] Build messages schema | assignee=backend-engineer | depends=T1,T2',
    );
    expect(directive).toEqual({
      type: 'task-add',
      title: 'Build messages schema',
      assignee: 'backend-engineer',
      dependsOn: ['T1', 'T2'],
    });
  });

  test('parses task lifecycle directives with inline ids', () => {
    expect(parseTeamDirectives('[[team:task:start:T3]]')).toEqual([{ type: 'task-start', id: 'T3' }]);
    expect(parseTeamDirectives('[[team:task:done:T3]]')).toEqual([{ type: 'task-done', id: 'T3' }]);
    expect(parseTeamDirectives('[[team:task:block:T2]] waiting on the API')).toEqual([
      { type: 'task-block', id: 'T2', reason: 'waiting on the API' },
    ]);
  });

  test('accepts an id supplied in the remainder', () => {
    expect(parseTeamDirectives('[[team:task:done]] T7')).toEqual([{ type: 'task-done', id: 'T7' }]);
  });

  test('ignores non-directive prose', () => {
    expect(parseTeamDirectives('Just some normal text about [[brackets]] that are not ours')).toEqual([]);
  });
});

describe('stripDirectives', () => {
  test('removes directive lines and keeps prose', () => {
    const text = ['Here is the plan.', '[[team:task:add]] Schema | assignee=backend-engineer', 'Done.'].join('\n');
    expect(stripDirectives(text)).toBe('Here is the plan.\nDone.');
  });
});

describe('applyDirectives', () => {
  test('posts messages and mutates the board', () => {
    const bus = new AgentMessageBus();
    const board = new TaskBoard();
    const directives = parseTeamDirectives(
      [
        '[[team:task:add]] Schema | assignee=backend-engineer',
        '[[team:task:add]] UI | assignee=frontend-engineer | depends=T1',
        '[[team:progress]] planning complete',
      ].join('\n'),
    );
    const result = applyDirectives(directives, bus, board, 'architect');

    expect(result.tasksChanged).toBe(2);
    expect(result.messagesPosted).toBe(1);
    expect(board.size).toBe(2);
    expect(board.get('T2')?.dependsOn).toEqual(['T1']);
    expect(bus.byKind('progress').length).toBe(1);
  });

  test('blocking a task posts a blocker message and updates status', () => {
    const bus = new AgentMessageBus();
    const board = new TaskBoard();
    board.add({ title: 'Schema', assignee: 'backend-engineer', id: 'T1' });
    applyDirectives(parseTeamDirectives('[[team:task:block:T1]] missing env var'), bus, board, 'backend-engineer');
    expect(board.get('T1')?.status).toBe('blocked');
    expect(bus.byKind('blocker').length).toBe(1);
  });

  test('defaults a task assignee to the authoring role', () => {
    const bus = new AgentMessageBus();
    const board = new TaskBoard();
    applyDirectives(parseTeamDirectives('[[team:task:add]] Audit access control'), bus, board, 'security-reviewer');
    expect(board.get('T1')?.assignee).toBe('security-reviewer');
  });
});
