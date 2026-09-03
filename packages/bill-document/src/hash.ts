import { createHash } from 'node:crypto';
import type { BillSection } from './types.js';
import { sectionText } from './text.js';

export { normalizeSpace, runsText, blockText, sectionText, changeSummary } from './text.js';

export function sha256(text: string | Buffer): string {
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

export function textHash(s: Pick<BillSection, 'introText' | 'blocks'>): string {
  return sha256(sectionText(s));
}
