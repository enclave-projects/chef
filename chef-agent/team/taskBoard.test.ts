import { describe, expect, test } from 'vitest';
import { TaskBoard } from './taskBoard.js';

describe('TaskBoard', () => {
  test('generates sequential ids and tracks tasks', () => {
    const board = new TaskBoard();
    const t1 = board.add({ title: 'Schema', assignee: 'backend-engineer' });
    const t2 = board.add({ title: 'UI', assignee: 'frontend-engineer' });
    expect(t1.id).toBe('T1');
    expect(t2.id).toBe('T2');
    expect(board.size).toBe(2);
  });

  test('rejects empty titles', () => {
    const board = new TaskBoard();
    expect(() => board.add({ title: '   ', assignee: 'architect' })).toThrow();
  });

  test('nextActionable respects dependencies', () => {
    const board = new TaskBoard();
    board.add({ title: 'Schema', assignee: 'backend-engineer', id: 'T1' });
    board.add({ title: 'UI', assignee: 'frontend-engineer', id: 'T2', dependsOn: ['T1'] });

    // T2 depends on T1, so the first actionable task is T1.
    expect(board.nextActionable()?.id).toBe('T1');
    // Scoped to the frontend, nothing is actionable yet.
    expect(board.nextActionable('frontend-engineer')).toBeUndefined();

    board.setStatus('T1', 'done');
    expect(board.nextActionable()?.id).toBe('T2');
    expect(board.nextActionable('frontend-engineer')?.id).toBe('T2');
  });

  test('summary and isComplete reflect statuses', () => {
    const board = new TaskBoard();
    board.add({ title: 'a', assignee: 'backend-engineer', id: 'T1' });
    board.add({ title: 'b', assignee: 'frontend-engineer', id: 'T2' });
    board.setStatus('T1', 'done');
    board.setStatus('T2', 'in-progress');

    const summary = board.summary();
    expect(summary.total).toBe(2);
    expect(summary.done).toBe(1);
    expect(summary.inProgress).toBe(1);
    expect(summary.percentComplete).toBe(50);
    expect(board.isComplete()).toBe(false);

    board.setStatus('T2', 'done');
    expect(board.isComplete()).toBe(true);
  });

  test('cancelled tasks do not block completion', () => {
    const board = new TaskBoard();
    board.add({ title: 'a', assignee: 'backend-engineer', id: 'T1' });
    board.add({ title: 'b', assignee: 'frontend-engineer', id: 'T2' });
    board.setStatus('T1', 'done');
    board.setStatus('T2', 'cancelled');
    expect(board.isComplete()).toBe(true);
  });

  test('add is idempotent when replaying the same id', () => {
    const board = new TaskBoard();
    board.add({ title: 'Schema', assignee: 'backend-engineer', id: 'T1' });
    board.add({ title: 'Schema (updated)', assignee: 'architect', id: 'T1' });
    expect(board.size).toBe(1);
    expect(board.get('T1')?.title).toBe('Schema (updated)');
    expect(board.get('T1')?.assignee).toBe('architect');
  });

  test('serialize/deserialize round-trips and continues id numbering', () => {
    const board = new TaskBoard();
    board.add({ title: 'a', assignee: 'backend-engineer' });
    const restored = TaskBoard.deserialize(board.serialize());
    const next = restored.add({ title: 'b', assignee: 'frontend-engineer' });
    expect(next.id).toBe('T2');
  });

  test('render shows status symbols', () => {
    const board = new TaskBoard();
    board.add({ title: 'Schema', assignee: 'backend-engineer', id: 'T1' });
    board.setStatus('T1', 'done');
    expect(board.render()).toContain('[x] T1');
  });
});
