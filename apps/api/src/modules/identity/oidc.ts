// OIDC relying party built on openid-client v6. Entra ID in production, apps/dev-oidc in development.
import * as client from 'openid-client';
import type { Config } from '../../config.js';
import { ROLES, type Principal, type Role } from './principal.js';

export interface OidcClient {
  authorizationUrl(state: string, nonce: string, codeVerifier: string, loginHint?: string): Promise<URL>;
  exchange(currentUrl: URL, state: string, nonce: string, codeVerifier: string): Promise<Principal>;
  verifyBearer(token: string): Promise<Principal | null>;
  endSessionUrl(): Promise<URL | null>;
}

export function claimsToPrincipal(claims: Record<string, unknown>, cfg: Pick<Config, 'OIDC_ROLE_CLAIM' | 'OIDC_DIVISION_CLAIM' | 'roleMap'>): Principal {
  const rawRoles = claims[cfg.OIDC_ROLE_CLAIM];
  const list = Array.isArray(rawRoles) ? rawRoles : typeof rawRoles === 'string' ? rawRoles.split(/[ ,]+/) : [];
  const roles = new Set<Role>();
  for (const r of list) {
    const mapped = cfg.roleMap[String(r)] ?? String(r);
    if ((ROLES as readonly string[]).includes(mapped)) roles.add(mapped as Role);
  }
  const rawDiv = claims[cfg.OIDC_DIVISION_CLAIM];
  const divisions = Array.isArray(rawDiv) ? rawDiv.map(String) : typeof rawDiv === 'string' ? [rawDiv] : [];
  const sub = String(claims.sub);
  return {
    userId: sub,
    displayName: String(claims.name ?? claims.preferred_username ?? claims.email ?? sub),
    email: typeof claims.email === 'string' ? claims.email : undefined,
    roles: [...roles],
    divisions,
  };
}

export function createOidcClient(cfg: Config): OidcClient {
  let configPromise: Promise<client.Configuration> | null = null;
  const discover = () => {
    if (!configPromise) {
      configPromise = client
        .discovery(new URL(cfg.OIDC_ISSUER), cfg.OIDC_CLIENT_ID, cfg.OIDC_CLIENT_SECRET, undefined, {
          execute: cfg.OIDC_ISSUER.startsWith('http://') ? [client.allowInsecureRequests] : [],
        })
        .catch((err) => {
          configPromise = null;
          throw err;
        });
    }
    return configPromise;
  };

  return {
    async authorizationUrl(state, nonce, codeVerifier, loginHint) {
      const c = await discover();
      const params: Record<string, string> = {
        redirect_uri: cfg.OIDC_REDIRECT_URI,
        scope: cfg.OIDC_SCOPES,
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
      };
      if (loginHint) params.login_hint = loginHint;
      return client.buildAuthorizationUrl(c, params);
    },
    async exchange(currentUrl, state, nonce, codeVerifier) {
      const c = await discover();
      const tokens = await client.authorizationCodeGrant(c, currentUrl, {
        expectedState: state,
        expectedNonce: nonce,
        pkceCodeVerifier: codeVerifier,
      });
      const claims = tokens.claims() ?? {};
      return claimsToPrincipal(claims as Record<string, unknown>, cfg);
    },
    async verifyBearer(token) {
      try {
        const c = await discover();
        const meta = c.serverMetadata();
        if (!meta.jwks_uri) return null;
        const { createRemoteJWKSet, jwtVerify } = await import('jose');
        const jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
        const { payload } = await jwtVerify(token, jwks, { issuer: meta.issuer, audience: cfg.OIDC_CLIENT_ID });
        return claimsToPrincipal(payload as Record<string, unknown>, cfg);
      } catch {
        return null;
      }
    },
    async endSessionUrl() {
      try {
        const c = await discover();
        const meta = c.serverMetadata();
        if (!meta.end_session_endpoint) return null;
        const url = new URL(meta.end_session_endpoint);
        url.searchParams.set('post_logout_redirect_uri', cfg.WEB_ORIGIN);
        return url;
      } catch {
        return null;
      }
    },
  };
}
