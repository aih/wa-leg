// Browser-safe entry: types, the reading-text diff, and plain-text helpers. No Node built-ins.
export * from './types.js';
export * from './diffdoc.js';
export { normalizeSpace, runsText, blockText, sectionText, changeSummary } from './text.js';
export { parseTitle, citesIn, rcwHref, RCW_BASE } from './title.js';
export { sectionSubject, paraphrase, cleanCaption, type SectionSubject } from './subject.js';
