// Minimal DOM over sax for the lawfilesext XML (namespace http://leg.wa.gov/2012/document).
import sax from 'sax';

export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<XNode | string>;
}

export function parseXml(xml: string): XNode {
  const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: false, position: false });
  const root: XNode = { tag: '#root', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  parser.onopentag = (node) => {
    const el: XNode = { tag: node.name.replace(/^.*:/, ''), attrs: {}, children: [] };
    for (const [k, v] of Object.entries(node.attributes)) el.attrs[k] = String(v);
    stack[stack.length - 1]!.children.push(el);
    stack.push(el);
  };
  parser.onclosetag = () => {
    stack.pop();
  };
  parser.ontext = (t) => {
    if (t) stack[stack.length - 1]!.children.push(t);
  };
  parser.oncdata = (t) => {
    if (t) stack[stack.length - 1]!.children.push(t);
  };
  parser.onerror = (err) => {
    throw err;
  };
  parser.write(text).close();
  const first = root.children.find((c): c is XNode => typeof c !== 'string');
  if (!first) throw new Error('empty document');
  return first;
}

export function isNode(c: XNode | string): c is XNode {
  return typeof c !== 'string';
}

export function child(n: XNode, tag: string): XNode | undefined {
  return n.children.find((c): c is XNode => isNode(c) && c.tag === tag);
}

export function children(n: XNode, tag?: string): XNode[] {
  return n.children.filter((c): c is XNode => isNode(c) && (tag === undefined || c.tag === tag));
}

/** Concatenated text content of a node, including descendants. */
export function textOf(n: XNode | string | undefined): string {
  if (n === undefined) return '';
  if (typeof n === 'string') return n;
  return n.children.map(textOf).join('');
}

export function childText(n: XNode, tag: string): string | undefined {
  const c = child(n, tag);
  return c ? textOf(c).trim() : undefined;
}

/** Depth-first search for the first descendant with the tag. */
export function find(n: XNode, tag: string): XNode | undefined {
  for (const c of n.children) {
    if (!isNode(c)) continue;
    if (c.tag === tag) return c;
    const f = find(c, tag);
    if (f) return f;
  }
  return undefined;
}

export function findAll(n: XNode, tag: string, out: XNode[] = []): XNode[] {
  for (const c of n.children) {
    if (!isNode(c)) continue;
    if (c.tag === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}
