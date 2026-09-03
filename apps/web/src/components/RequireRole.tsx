import type { ReactNode } from 'react';
import { useSession, type Role } from '../lib/session';
import { loginUrl } from '../lib/api';

export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { principal, loading, hasRole } = useSession();
  if (loading) return <p aria-live="polite">Loading…</p>;
  if (!principal) {
    return (
      <p>
        <a href={loginUrl()}>Sign in</a> to continue.
      </p>
    );
  }
  if (roles.length > 0 && !hasRole(...roles)) {
    return (
      <p role="alert">
        This page needs the {roles.join(' or ')} role. You are signed in as {principal.displayName} ({principal.roles.join(', ')}).
      </p>
    );
  }
  return <>{children}</>;
}
