import { describe, expect, test } from 'vitest';
import { assembleTeam, assessComplexity } from './roleAssignment.js';
import type { AgentRole } from './types.js';

function roles(members: { role: AgentRole }[]): AgentRole[] {
  return members.map((m) => m.role);
}

describe('assessComplexity', () => {
  test('treats a tiny request as trivial', () => {
    const result = assessComplexity('Add a hello world page');
    expect(result.complexity).toBe('trivial');
    expect(result.score).toBeLessThanOrEqual(2);
  });

  test('scores a multi-feature, security-heavy app as complex', () => {
    const task = `Build a marketplace with:
- user authentication and login
- file upload to storage for product images
- real-time chat between buyers and sellers
- search across listings
- an admin dashboard with role-based permissions
- stripe payments and billing`;
    const result = assessComplexity(task);
    expect(result.complexity).toBe('complex');
    expect(result.score).toBeGreaterThan(12);
    expect(result.factors.length).toBeGreaterThan(0);
  });

  test('flags security and integration signals', () => {
    const result = assessComplexity('An app with login, permissions and file upload to storage');
    const labels = result.factors.map((f) => f.label).join(' ');
    expect(labels).toMatch(/security-sensitive/);
    expect(labels).toMatch(/external integration/);
  });
});

describe('assembleTeam', () => {
  test('keeps a trivial team lean (no architect, no specialists)', () => {
    const team = assembleTeam('Add a counter button');
    expect(team.complexity).toBe('trivial');
    expect(team.head.role).toBe('team-head');
    expect(roles(team.members)).toEqual(['backend-engineer', 'frontend-engineer']);
  });

  test('recruits specialists for complex, sensitive work', () => {
    const task = `Build a marketplace with:
- user authentication and login
- file upload to storage for product images
- search across listings
- an admin dashboard with role-based permissions
- stripe payments`;
    const team = assembleTeam(task);
    const memberRoles = roles(team.members);
    expect(team.complexity).toBe('complex');
    expect(memberRoles).toContain('architect');
    expect(memberRoles).toContain('backend-engineer');
    expect(memberRoles).toContain('frontend-engineer');
    expect(memberRoles).toContain('security-reviewer');
    expect(memberRoles).toContain('integration-engineer');
    expect(memberRoles).toContain('qa-engineer');
  });

  test('always includes a Team Head and a rationale', () => {
    const team = assembleTeam('Build a Slack clone with channels and messages');
    expect(team.head.role).toBe('team-head');
    expect(team.rationale).toContain('Team Head');
  });

  test('does not duplicate roles', () => {
    const team = assembleTeam('App with login, payments, file upload, search, and an admin dashboard');
    const memberRoles = roles(team.members);
    expect(new Set(memberRoles).size).toBe(memberRoles.length);
  });
});
