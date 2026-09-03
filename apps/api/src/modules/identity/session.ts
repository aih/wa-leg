import { SignJWT, jwtVerify } from 'jose';
import { PrincipalSchema, type Principal } from './principal.js';

export const SESSION_COOKIE = 'session';

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(principal: Principal, secret: string, ttlSeconds: number): Promise<string> {
  return new SignJWT({ p: principal })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('wa-leg')
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

export async function verifySession(token: string, secret: string): Promise<Principal | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: 'wa-leg' });
    const parsed = PrincipalSchema.safeParse(payload.p);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
