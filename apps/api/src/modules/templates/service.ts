// Templates module: the twelve HTML fragments and their manifest, loaded into the `templates` table at seed time.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';

export interface TemplateSummary {
  id: string;
  name: string;
  kind: 'document' | 'snippet';
  mode: 'limited' | 'full';
  version: number;
  description: string;
  file?: string;
  tags: string[];
  parts: string[];
  tables: string[];
  slots: { id: string; required: boolean; hint?: string }[];
  tokens: string[];
  updatedAt: string;
}

export interface TemplateFull extends TemplateSummary {
  html: string;
  etag: string;
}

interface ManifestEntry {
  id: string;
  name: string;
  file: string;
  description: string;
  tags: string[];
  parts: string[];
  tables: string[];
  slots: string[];
  tokens: string[];
  kind?: 'document' | 'snippet';
  mode?: 'limited' | 'full';
}

function etagOf(html: string): string {
  return '"' + createHash('sha256').update(html).digest('hex').slice(0, 24) + '"';
}

/** Seed the templates table from design/templates. Files are the seed; a changed file becomes a new version. */
export async function seedTemplates(db: DbOrTx, dir: string): Promise<number> {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`templates manifest not found at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { templates: ManifestEntry[] };
  let n = 0;
  for (const t of manifest.templates) {
    const html = readFileSync(join(dir, t.file), 'utf8');
    const etag = etagOf(html);
    const current = (await db.execute(sql`SELECT version, etag FROM templates WHERE id = ${t.id} AND current ORDER BY version DESC LIMIT 1`)).rows[0] as { version: number; etag: string } | undefined;
    if (current && current.etag === etag) continue;
    const version = (current?.version ?? 0) + 1;
    if (current) await db.execute(sql`UPDATE templates SET current = false WHERE id = ${t.id}`);
    const slots = t.slots.map((s) => ({ id: s, required: !/^(agency|approver|ofm|preparer|legContact|request|bill\.(number|title))/.test(s) }));
    await db.execute(sql`INSERT INTO templates (id, version, name, kind, mode, description, file, tags, parts, tables, slots, tokens, html, etag, current, updated_by)
      VALUES (${t.id}, ${version}, ${t.name}, ${t.kind ?? 'document'}, ${t.mode ?? 'limited'}, ${t.description}, ${t.file}, ${JSON.stringify(t.tags)}::jsonb,
        ${JSON.stringify(t.parts)}::jsonb, ${JSON.stringify(t.tables)}::jsonb, ${JSON.stringify(slots)}::jsonb, ${JSON.stringify(t.tokens)}::jsonb, ${html}, ${etag}, true, 'seed')`);
    n++;
  }
  return n;
}

function row(r: any): TemplateFull {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    mode: r.mode,
    version: r.version,
    description: r.description ?? '',
    file: r.file ?? undefined,
    tags: r.tags ?? [],
    parts: r.parts ?? [],
    tables: r.tables ?? [],
    slots: r.slots ?? [],
    tokens: r.tokens ?? [],
    html: r.html,
    etag: r.etag,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export class TemplatesService {
  constructor(private readonly db: Db) {}

  async list(filter: { mode?: string; kind?: string; taxType?: string; impactType?: string; q?: string } = {}): Promise<TemplateSummary[]> {
    const rows = (await this.db.execute(sql`SELECT * FROM templates WHERE current ORDER BY file, id`)).rows as any[];
    return rows
      .map(row)
      .filter((t) => (!filter.mode || t.mode === filter.mode) && (!filter.kind || t.kind === filter.kind))
      .filter((t) => !filter.taxType || t.tags.includes(`tax:${filter.taxType}`) || t.tags.includes(filter.taxType))
      .filter((t) => !filter.impactType || t.tags.includes(`impact:${filter.impactType}`) || t.tags.includes(filter.impactType))
      .filter((t) => {
        if (!filter.q) return true;
        const q = filter.q.toLowerCase();
        return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.tags.some((x) => x.toLowerCase().includes(q));
      })
      .map(({ html: _h, etag: _e, ...summary }) => summary);
  }

  async get(id: string, version?: number): Promise<TemplateFull> {
    const r = (await this.db.execute(version ? sql`SELECT * FROM templates WHERE id = ${id} AND version = ${version}` : sql`SELECT * FROM templates WHERE id = ${id} AND current`)).rows[0];
    if (!r) throw notFound(`Template ${id}`);
    return row(r);
  }

  async update(id: string, patch: { name?: string; description?: string; html?: string; tags?: string[]; kind?: string; mode?: string }, actor: string): Promise<TemplateFull> {
    const current = await this.get(id);
    const html = patch.html ?? current.html;
    const version = current.version + 1;
    await this.db.execute(sql`UPDATE templates SET current = false WHERE id = ${id}`);
    await this.db.execute(sql`INSERT INTO templates (id, version, name, kind, mode, description, file, tags, parts, tables, slots, tokens, html, etag, current, updated_by)
      VALUES (${id}, ${version}, ${patch.name ?? current.name}, ${patch.kind ?? current.kind}, ${patch.mode ?? current.mode}, ${patch.description ?? current.description}, ${current.file ?? null},
        ${JSON.stringify(patch.tags ?? current.tags)}::jsonb, ${JSON.stringify(current.parts)}::jsonb, ${JSON.stringify(current.tables)}::jsonb, ${JSON.stringify(current.slots)}::jsonb,
        ${JSON.stringify(current.tokens)}::jsonb, ${html}, ${etagOf(html)}, true, ${actor})`);
    return this.get(id);
  }
}
