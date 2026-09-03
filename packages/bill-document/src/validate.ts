// Structural validation against schemas/bill-document.json and schemas/amendment-document.json.
// A small checker over the parts of JSON Schema those files use (required, enum, type, pattern, items).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const billSchema = require('../schemas/bill-document.json') as Schema;
const amendmentSchema = require('../schemas/amendment-document.json') as Schema;

interface Schema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minimum?: number;
  $ref?: string;
  $defs?: Record<string, Schema>;
  description?: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

function resolveRef(ref: string, roots: Record<string, Schema>): Schema {
  const [file, frag] = ref.split('#');
  const root = file ? roots[file] : roots.self;
  if (!root) throw new Error(`Unknown schema ${file}`);
  if (!frag || frag === '/') return root;
  let node: any = root;
  for (const part of frag.replace(/^\//, '').split('/')) node = node?.[part];
  if (!node) throw new Error(`Unresolvable ref ${ref}`);
  return node as Schema;
}

function check(value: unknown, schema: Schema, path: string, roots: Record<string, Schema>, out: ValidationIssue[]): void {
  if (schema.$ref) {
    const [file] = schema.$ref.split('#');
    const scoped = file && roots[file] ? { ...roots, self: roots[file]! } : roots;
    return check(value, resolveRef(schema.$ref, roots), path, scoped, out);
  }
  if (schema.const !== undefined && value !== schema.const) out.push({ path, message: `expected ${JSON.stringify(schema.const)}` });
  if (schema.enum && !schema.enum.includes(value)) out.push({ path, message: `expected one of ${schema.enum.join(', ')}` });
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const ok = types.some((t) => (t === 'integer' ? typeof value === 'number' && Number.isInteger(value) : t === actual));
    if (!ok) {
      out.push({ path, message: `expected ${types.join('|')}, got ${actual}` });
      return;
    }
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) out.push({ path, message: `does not match ${schema.pattern}` });
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) out.push({ path, message: `below minimum ${schema.minimum}` });
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => check(v, schema.items!, `${path}[${i}]`, roots, out));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) out.push({ path, message: `missing required ${r}` });
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in obj) check(obj[k], sub, `${path}.${k}`, roots, out);
  }
}

export function validateBillDocument(doc: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  check(doc, billSchema, '$', { self: billSchema, 'bill-document.json': billSchema }, out);
  return out;
}

export function validateAmendmentDocument(doc: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  check(doc, amendmentSchema, '$', { self: amendmentSchema, 'bill-document.json': billSchema, 'amendment-document.json': amendmentSchema }, out);
  return out;
}
