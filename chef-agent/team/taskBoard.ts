/**
 * Task management for the agent team.
 *
 * The TaskBoard tracks the units of work the team has identified, who owns
 * them, their status, and their dependencies. It is the source of truth for
 * "what's next" and for the progress summary shown to the user. Like the rest
 * of the module it is pure and serializable so it can be rebuilt from history.
 */
import type { AgentRole, Task, TaskStatus } from './types.js';

export interface AddTaskOptions {
  title: string;
  assignee: AgentRole;
  dependsOn?: string[];
  /** Provide an explicit id (used when replaying history); otherwise generated. */
  id?: string;
  /** Bus sequence at creation time, for stable ordering. */
  seq?: number;
}

export interface TaskSummary {
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
  pending: number;
  cancelled: number;
  /** Percentage of non-cancelled tasks that are done (0-100, integer). */
  percentComplete: number;
}

export class TaskBoard {
  private tasks: Map<string, Task>;
  private counter: number;

  constructor(initial: Task[] = []) {
    this.tasks = new Map(initial.map((t) => [t.id, { ...t, dependsOn: [...t.dependsOn] }]));
    this.counter = initial.reduce((max, t) => {
      const n = parseTaskNumber(t.id);
      return n !== null ? Math.max(max, n) : max;
    }, 0);
  }

  get size(): number {
    return this.tasks.size;
  }

  add(options: AddTaskOptions): Task {
    const title = options.title.trim();
    if (title.length === 0) {
      throw new Error('Cannot add a task with an empty title');
    }
    const id = options.id ?? `T${++this.counter}`;
    if (options.id) {
      const n = parseTaskNumber(options.id);
      if (n !== null) {
        this.counter = Math.max(this.counter, n);
      }
    }
    if (this.tasks.has(id)) {
      // Idempotent when replaying history: update the title/assignee instead of duplicating.
      const existing = this.tasks.get(id)!;
      existing.title = title;
      existing.assignee = options.assignee;
      if (options.dependsOn) {
        existing.dependsOn = [...options.dependsOn];
      }
      return existing;
    }
    const seq = options.seq ?? 0;
    const task: Task = {
      id,
      title,
      assignee: options.assignee,
      status: 'pending',
      dependsOn: options.dependsOn ? [...options.dependsOn] : [],
      createdSeq: seq,
      updatedSeq: seq,
    };
    this.tasks.set(id, task);
    return task;
  }

  get(id: string): Task | undefined {
    const task = this.tasks.get(id);
    return task ? { ...task, dependsOn: [...task.dependsOn] } : undefined;
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  /** Update a task's status. Returns the updated task, or undefined if missing. */
  setStatus(id: string, status: TaskStatus, seq = 0, notes?: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      return undefined;
    }
    task.status = status;
    task.updatedSeq = seq;
    if (notes !== undefined) {
      task.notes = notes;
    }
    return { ...task, dependsOn: [...task.dependsOn] };
  }

  reassign(id: string, assignee: AgentRole, seq = 0): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      return undefined;
    }
    task.assignee = assignee;
    task.updatedSeq = seq;
    return { ...task, dependsOn: [...task.dependsOn] };
  }

  all(): Task[] {
    return Array.from(this.tasks.values()).map((t) => ({ ...t, dependsOn: [...t.dependsOn] }));
  }

  byAssignee(role: AgentRole): Task[] {
    return this.all().filter((t) => t.assignee === role);
  }

  byStatus(status: TaskStatus): Task[] {
    return this.all().filter((t) => t.status === status);
  }

  /** True when every dependency of a task is done. */
  dependenciesMet(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) {
      return false;
    }
    return task.dependsOn.every((depId) => this.tasks.get(depId)?.status === 'done');
  }

  /**
   * The next actionable task: pending, with all dependencies met. Optionally
   * scoped to a single assignee. Preserves insertion order.
   */
  nextActionable(role?: AgentRole): Task | undefined {
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') {
        continue;
      }
      if (role && task.assignee !== role) {
        continue;
      }
      if (this.dependenciesMet(task.id)) {
        return { ...task, dependsOn: [...task.dependsOn] };
      }
    }
    return undefined;
  }

  /** Whether there is no remaining work (every task done or cancelled). */
  isComplete(): boolean {
    if (this.tasks.size === 0) {
      return false;
    }
    return Array.from(this.tasks.values()).every((t) => t.status === 'done' || t.status === 'cancelled');
  }

  summary(): TaskSummary {
    let done = 0;
    let inProgress = 0;
    let blocked = 0;
    let pending = 0;
    let cancelled = 0;
    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'done':
          done++;
          break;
        case 'in-progress':
          inProgress++;
          break;
        case 'blocked':
          blocked++;
          break;
        case 'pending':
          pending++;
          break;
        case 'cancelled':
          cancelled++;
          break;
      }
    }
    const total = this.tasks.size;
    const billable = total - cancelled;
    const percentComplete = billable > 0 ? Math.round((done / billable) * 100) : 0;
    return { total, done, inProgress, blocked, pending, cancelled, percentComplete };
  }

  /** Human-readable board for prompts / user feedback. */
  render(): string {
    if (this.tasks.size === 0) {
      return '(no tasks yet)';
    }
    const symbols: Record<TaskStatus, string> = {
      pending: '[ ]',
      'in-progress': '[~]',
      blocked: '[!]',
      done: '[x]',
      cancelled: '[-]',
    };
    return this.all()
      .map((t) => {
        const deps = t.dependsOn.length > 0 ? ` (after ${t.dependsOn.join(', ')})` : '';
        const notes = t.notes ? ` — ${t.notes}` : '';
        return `${symbols[t.status]} ${t.id} · ${t.assignee}: ${t.title}${deps}${notes}`;
      })
      .join('\n');
  }

  serialize(): Task[] {
    return this.all();
  }

  static deserialize(tasks: Task[]): TaskBoard {
    return new TaskBoard(tasks);
  }
}

function parseTaskNumber(id: string): number | null {
  const match = /^T(\d+)$/.exec(id);
  return match ? parseInt(match[1], 10) : null;
}
