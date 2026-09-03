import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient } from '../src/index.js';

describe('api-client', () => {
  it('builds typed requests against the generated paths', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const client = createClient({
      baseUrl: 'http://api.test/api/v1',
      token: 't0k',
      fetch: async (req: Request) => {
        calls.push({ url: req.url, headers: Object.fromEntries(req.headers.entries()) });
        return new Response(JSON.stringify({ userId: 'dev-drafter', displayName: 'Dana', roles: ['drafter'], divisions: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const { data, error } = await client.GET('/me');
    expect(error).toBeUndefined();
    expect(data?.userId).toBe('dev-drafter');
    expect(calls[0]!.url).toBe('http://api.test/api/v1/me');
    expect(calls[0]!.headers.authorization).toBe('Bearer t0k');
  });

  it('the checked-in schema covers the notes, bills, search and templates routes', () => {
    const schema = readFileSync(new URL('../src/schema.d.ts', import.meta.url), 'utf8');
    for (const path of ['"/notes/{id}/document"', '"/bills/{biennium}/{id}/versions/{code}"', '"/search"', '"/templates/{id}"', '"/notes/{id}/comments/{cid}/messages"']) {
      expect(schema).toContain(path);
    }
  });
});
