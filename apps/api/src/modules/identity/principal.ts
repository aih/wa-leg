import { z } from 'zod';

export const ROLES = ['drafter', 'reviewer', 'viewer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const PrincipalSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  email: z.string().optional(),
  roles: z.array(z.enum(ROLES)),
  divisions: z.array(z.string()).default([]),
});
export type Principal = z.infer<typeof PrincipalSchema>;

/** The CLI and the seed act as this principal. It has no screens. */
export const SYSTEM_PRINCIPAL: Principal = {
  userId: 'system',
  displayName: 'System',
  roles: ['admin'],
  divisions: [],
};

export function hasRole(p: Principal, ...roles: Role[]): boolean {
  return roles.some((r) => p.roles.includes(r));
}
