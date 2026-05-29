import { describe, expect, test } from 'vitest';
import { AgentMessageBus, formatMessage } from './messageBus.js';

describe('AgentMessageBus', () => {
  test('assigns monotonic sequence numbers', () => {
    const bus = new AgentMessageBus();
    const a = bus.post({ from: 'architect', kind: 'progress', content: 'designed schema' });
    const b = bus.post({ from: 'backend-engineer', kind: 'progress', content: 'wrote mutation' });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(bus.cursor).toBe(2);
  });

  test('defaults recipient to broadcast and trims content', () => {
    const bus = new AgentMessageBus();
    const msg = bus.post({ from: 'architect', kind: 'notice', content: '  heads up  ' });
    expect(msg.to).toBe('all');
    expect(msg.content).toBe('heads up');
  });

  test('rejects empty content', () => {
    const bus = new AgentMessageBus();
    expect(() => bus.post({ from: 'architect', kind: 'notice', content: '   ' })).toThrow();
  });

  test('messagesFor returns broadcasts, inbound, and outbound', () => {
    const bus = new AgentMessageBus();
    bus.post({ from: 'architect', kind: 'notice', content: 'broadcast' });
    bus.post({ from: 'backend-engineer', kind: 'handoff', content: 'to fe', to: 'frontend-engineer' });
    bus.post({ from: 'security-reviewer', kind: 'notice', content: 'to backend', to: 'backend-engineer' });

    const forFrontend = bus.messagesFor('frontend-engineer');
    expect(forFrontend.map((m) => m.content)).toEqual(['broadcast', 'to fe']);

    const forBackend = bus.messagesFor('backend-engineer');
    expect(forBackend.map((m) => m.content)).toContain('to backend');
    expect(forBackend.map((m) => m.content)).toContain('to fe');
  });

  test('byKind, since, and recent filter correctly', () => {
    const bus = new AgentMessageBus();
    bus.post({ from: 'architect', kind: 'requirement', content: 'r1' });
    bus.post({ from: 'architect', kind: 'progress', content: 'p1' });
    bus.post({ from: 'architect', kind: 'requirement', content: 'r2' });

    expect(bus.byKind('requirement').map((m) => m.content)).toEqual(['r1', 'r2']);
    expect(bus.since(1).map((m) => m.content)).toEqual(['p1', 'r2']);
    expect(bus.recent(2).map((m) => m.content)).toEqual(['p1', 'r2']);
  });

  test('serialize/deserialize round-trips and preserves the cursor', () => {
    const bus = new AgentMessageBus();
    bus.post({ from: 'architect', kind: 'progress', content: 'a' });
    bus.post({ from: 'architect', kind: 'progress', content: 'b' });
    const restored = AgentMessageBus.deserialize(bus.serialize());
    expect(restored.cursor).toBe(2);
    const next = restored.post({ from: 'architect', kind: 'progress', content: 'c' });
    expect(next.seq).toBe(2);
  });

  test('formatMessage renders a readable line', () => {
    const bus = new AgentMessageBus();
    const msg = bus.post({ from: 'team-head', kind: 'review', content: 'looks good', to: 'backend-engineer' });
    const line = formatMessage(msg);
    expect(line).toContain('Team Head');
    expect(line).toContain('Backend Engineer');
    expect(line).toContain('looks good');
  });
});
