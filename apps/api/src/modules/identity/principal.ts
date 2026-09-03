import { z } from 'zod';
import type { Actor, MachineRole } from '@wa-leg/workflow-machine';

export const ROLES = ['drafter', 'reviewer', 'approver', 'manager', 'viewer', 'template_editor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const PrincipalSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  email: z.string().optional(),
  roles: z.array(z.enum(ROLES)),
  divisions: z.array(z.string()).default([]),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const SYSTEM_PRINCIPAL: Principal = {
  userId: 'system',
  displayName: 'System',
  roles: ['admin'],
  divisions: [],
};

export function hasRole(p: Principal, ...roles: Role[]): boolean {
  return roles.some((r) => p.roles.includes(r));
}

/**
 * Map application roles to the workflow machine's guard roles.
 * reviewer: editor (claims and reviews) and manager (assigns, per personas-dashboards.md "reviewer (assigner)").
 * approver: executive (member of an Executive Review chain) and editor.
 * manager and admin: manager. The system principal is `system`.
 */
export function toActor(p: Principal): Actor {
  if (p.userId === SYSTEM_PRINCIPAL.userId) return { userId: p.userId, roles: ['system', 'manager'] };
  const roles = new Set<MachineRole>();
  for (const r of p.roles) {
    switch (r) {
      case 'drafter':
        roles.add('drafter');
        break;
      case 'reviewer':
        roles.add('editor');
        roles.add('manager');
        break;
      case 'approver':
        roles.add('executive');
        roles.add('editor');
        break;
      case 'manager':
      case 'admin':
        roles.add('manager');
        break;
      default:
        break;
    }
  }
  return { userId: p.userId, roles: [...roles] };
}
