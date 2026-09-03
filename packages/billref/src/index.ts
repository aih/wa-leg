// Bill reference parser and formatter. No imports, no I/O.
// Grammar and normalization rules: design/research/search.md section 2.
// Canonical version code for an introduced bill is `I`; `lawfilesSuffix('I')` is the empty string.

export type Chamber = 'H' | 'S';
export type BillType = 'HB' | 'SB' | 'HJR' | 'SJR' | 'HJM' | 'SJM' | 'HCR' | 'SCR' | 'HR' | 'SR';

export interface AmendmentRef {
  kind: 'amendment';
  chamber?: Chamber | 'C';
  committeeOrSponsor?: string;
  drafterNumber?: string;
  initials?: string;
  amdNumber?: number;
}
export interface BillRef {
  kind: 'bill';
  biennium: string;
  bienniumExplicit: boolean;
  chamber: Chamber;
  type: BillType;
  number: number;
  versionCode: string;
  versionExplicit: boolean;
  amendment?: AmendmentRef;
  confidence: 'exact' | 'inferred';
  warnings: string[];
}
export interface RcwRef {
  kind: 'rcw';
  title: string;
  chapter?: string;
  section?: string;
  cite: string;
}
export interface SessionLawRef {
  kind: 'session_law';
  year: number;
  chapter: number;
  pv: boolean;
}
export interface FnPackageRef {
  kind: 'fiscal_note_package';
  packageId: number;
}
export interface InitiativeRef {
  kind: 'initiative';
  number: number;
}
export type Ref = BillRef | AmendmentRef | RcwRef | SessionLawRef | FnPackageRef | InitiativeRef;

export interface ParseResult {
  ref: Ref | null;
  remainder: string;
  normalized: string;
}
export interface ParseOptions {
  currentBiennium: string;
}

export const INTRODUCED = 'I';
export const BILL_TYPES: readonly BillType[] = ['HB', 'SB', 'HJR', 'SJR', 'HJM', 'SJM', 'HCR', 'SCR', 'HR', 'SR'];
const TYPES = BILL_TYPES.join('|');
const HOUSE: ReadonlySet<BillType> = new Set(['HB', 'HJR', 'HJM', 'HCR', 'HR']);

type Rewrite = [RegExp, string | ((m: string) => string)];
const WORD_FORMS: Rewrite[] = [
  [/\b((?:[A-Z0-9]\.\s?){2,})/g, (m: string) => m.replace(/[.\s]/g, '')],
  [/\bHOUSE\s+JOINT\s+RESOLUTION\b/g, 'HJR'],
  [/\bSENATE\s+JOINT\s+RESOLUTION\b/g, 'SJR'],
  [/\bHOUSE\s+JOINT\s+MEMORIAL\b/g, 'HJM'],
  [/\bSENATE\s+JOINT\s+MEMORIAL\b/g, 'SJM'],
  [/\bHOUSE\s+CONCURRENT\s+RESOLUTION\b/g, 'HCR'],
  [/\bSENATE\s+CONCURRENT\s+RESOLUTION\b/g, 'SCR'],
  [/\bHOUSE\s+RESOLUTION\b/g, 'HR'],
  [/\bSENATE\s+RESOLUTION\b/g, 'SR'],
  [/\bHOUSE\s+BILL\b/g, 'HB'],
  [/\bSENATE\s+BILL\b/g, 'SB'],
  [/\b(?:SECOND|2ND)\s+SUBSTITUTE\b/g, '2S'],
  [/\b(?:THIRD|3RD)\s+SUBSTITUTE\b/g, '3S'],
  [/\b(?:FIRST\s+)?SUBSTITUTE\b/g, 'S'],
  [/\b(?:SECOND|2ND)\s+ENGROSSED\b/g, '2E'],
  [/\b(?:THIRD|3RD)\s+ENGROSSED\b/g, '3E'],
  [/\bENGROSSED\b/g, 'E'],
  [/\bINITIATIVE(?:\s+MEASURE)?(?:\s+NO\.?)?\s*/g, 'I-'],
  [/\b(?:NO\.?|NUMBER)\s+(?=\d)/g, ''],
  [new RegExp(`\\b([23]?S)\\s+(?=(?:${TYPES})\\b)`, 'g'), '$1'],
  [new RegExp(`\\b([23]?E)\\s+(?=[23]?S?(?:${TYPES})\\b)`, 'g'), '$1'],
];

export function normalize(input: string): string {
  let s = input.trim().toUpperCase().replace(/\s+/g, ' ');
  for (const [re, rep] of WORD_FORMS) s = typeof rep === 'string' ? s.replace(re, rep) : s.replace(re, rep);
  return s;
}

export function bienniumOf(year: number): string {
  const start = year % 2 === 1 ? year : year - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}
function bienniumFromMatch(y: string): string {
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  return bienniumOf(year);
}

export function typeForNumber(n: number): { type: BillType; inRange: boolean } {
  const table: Array<[number, number, BillType]> = [
    [1000, 3999, 'HB'],
    [4000, 4199, 'HJM'],
    [4200, 4399, 'HJR'],
    [4400, 4599, 'HCR'],
    [4600, 4999, 'HR'],
    [5000, 7999, 'SB'],
    [8000, 8199, 'SJM'],
    [8200, 8399, 'SJR'],
    [8400, 8599, 'SCR'],
    [8600, 8999, 'SR'],
  ];
  for (const [lo, hi, t] of table) if (n >= lo && n <= hi) return { type: t, inRange: true };
  return { type: n < 5000 ? 'HB' : 'SB', inRange: false };
}

export function chamberOf(type: BillType): Chamber {
  return HOUSE.has(type) ? 'H' : 'S';
}

/** Build a version code from label prefixes ("2E","S") and/or a lawfiles suffix ("-S2", ".E"). */
export function versionCode(eng?: string, sub?: string, lsub?: string, leng?: string): string {
  let s = sub ? (sub.length === 1 ? 'S' : `S${sub[0]}`) : '';
  let e = eng ? (eng.length === 1 ? 'E' : `E${eng[0]}`) : '';
  if (lsub) s = `S${lsub.slice(2)}`;
  let stage = '';
  if (leng) {
    const t = leng.slice(1);
    if (t === 'PL' || t === 'SL') stage = t;
    else e = t;
  }
  return [s, stage || e].filter(Boolean).join('.') || INTRODUCED;
}

export interface DecodedVersion {
  substitute: number;
  engrossed: number;
  stage: '' | 'PL' | 'SL';
}

export function decodeVersion(code: string): DecodedVersion {
  if (code === INTRODUCED || code === '') return { substitute: 0, engrossed: 0, stage: '' };
  const m = /^(?:S(\d?))?(?:\.?(?:E(\d?)|(PL|SL)))?$/.exec(code);
  if (!m || code === '.') throw new Error(`bad version code ${code}`);
  return {
    substitute: m[1] === undefined ? 0 : Number(m[1] || 1),
    engrossed: m[2] === undefined ? 0 : Number(m[2] || 1),
    stage: (m[3] as 'PL' | 'SL' | undefined) ?? '',
  };
}

export function isVersionCode(code: string): boolean {
  try {
    decodeVersion(code);
    return true;
  } catch {
    return false;
  }
}

/** Order versions: introduced, substitutes and engrossments, then passed legislature, then session law. */
export function versionSeq(code: string): number {
  const v = decodeVersion(code);
  const stage = v.stage === 'PL' ? 100 : v.stage === 'SL' ? 200 : 0;
  return stage + v.substitute * 10 + v.engrossed;
}

/** Short label: "ESHB 1234", "2SSB 5001", "SHB 1234 (PL)". For PL/SL pass the engrossed level from the version list. */
export function label(ref: Pick<BillRef, 'type' | 'number' | 'versionCode'>, engrossedOverride?: number): string {
  const v = decodeVersion(ref.versionCode);
  const e = engrossedOverride ?? v.engrossed;
  const ep = e === 0 ? '' : e === 1 ? 'E' : `${e}E`;
  const sp = v.substitute === 0 ? '' : v.substitute === 1 ? 'S' : `${v.substitute}S`;
  return `${ep}${sp}${ref.type} ${ref.number}${v.stage ? ` (${v.stage})` : ''}`;
}

const TYPE_WORDS: Record<BillType, string> = {
  HB: 'House Bill',
  SB: 'Senate Bill',
  HJR: 'House Joint Resolution',
  SJR: 'Senate Joint Resolution',
  HJM: 'House Joint Memorial',
  SJM: 'Senate Joint Memorial',
  HCR: 'House Concurrent Resolution',
  SCR: 'Senate Concurrent Resolution',
  HR: 'House Resolution',
  SR: 'Senate Resolution',
};
const ORDINALS = ['', '', 'Second ', 'Third ', 'Fourth '];

/** Long label: "Engrossed Substitute House Bill", "Second Substitute Senate Bill (Passed Legislature)". */
export function longLabel(type: BillType, code: string, engrossedOverride?: number): string {
  const v = decodeVersion(code);
  const e = engrossedOverride ?? v.engrossed;
  const parts: string[] = [];
  if (e) parts.push(`${ORDINALS[e] ?? `${e}th `}Engrossed`);
  if (v.substitute) parts.push(`${ORDINALS[v.substitute] ?? `${v.substitute}th `}Substitute`);
  parts.push(TYPE_WORDS[type]);
  const stage = v.stage === 'PL' ? ' (Passed Legislature)' : v.stage === 'SL' ? ' (Session Law)' : '';
  return parts.join(' ') + stage;
}

/** Lawfilesext file-name suffix: "" for introduced, "-S2.E" for an engrossed second substitute. */
export function lawfilesSuffix(code: string): string {
  const v = decodeVersion(code);
  const s = v.substitute ? `-S${v.substitute === 1 ? '' : v.substitute}` : '';
  const tail = v.stage ? `.${v.stage}` : v.engrossed ? `.E${v.engrossed === 1 ? '' : v.engrossed}` : '';
  return s + tail;
}
export const fileSuffix = lawfilesSuffix;

/** Version code from a lawfilesext file name ("2402-S.E", "4600-Apple blossom festival", "4691-"). */
export function parseVersionFile(name: string): { number: number; code: string; title?: string } | null {
  const base = name.replace(/\.(pdf|htm|xml)$/i, '');
  const m = /^(\d{4})((?:-S\d?)?(?:\.E\d?)?(?:\.(?:PL|SL))?)(?:-(.*))?$/.exec(base);
  if (!m) return null;
  const number = Number(m[1]);
  const suffix = m[2] ?? '';
  const lsub = /-S\d?/.exec(suffix)?.[0];
  const leng = /\.(?:E\d?|PL|SL)$/.exec(suffix)?.[0];
  const title = m[3] ? m[3].trim() : undefined;
  return { number, code: versionCode(undefined, undefined, lsub, leng), ...(title ? { title } : {}) };
}

export function billKey(r: Pick<BillRef, 'biennium' | 'type' | 'number'>): string {
  return `WA:${r.biennium}:${r.type}${r.number}`;
}

export function parseBillKey(key: string): { biennium: string; type: BillType; number: number; id: string } | null {
  const m = new RegExp(`^WA:(\\d{4}-\\d{2}):(${TYPES})(\\d{1,5})$`).exec(key);
  if (!m) return null;
  return { biennium: m[1]!, type: m[2] as BillType, number: Number(m[3]), id: `${m[2]}${m[3]}` };
}

export function parseBillId(id: string): { type: BillType; number: number } | null {
  const m = new RegExp(`^(${TYPES})(\\d{1,5})$`, 'i').exec(id.trim());
  if (!m) return null;
  return { type: m[1]!.toUpperCase() as BillType, number: Number(m[2]) };
}

const RE = {
  sessionLaw:
    /^(?:CH(?:APTER)?\.?\s*(\d{1,4}),?\s*(?:LAWS\s+OF\s+((?:19|20)\d\d)|((?:19|20)\d\d)\s+LAWS)|((?:19|20)\d\d)\s+C\s+(\d{1,4}))\s*(PV)?\b/,
  rcw: /^(?:RCW\s*)?(\d{1,2}[A-Z]?)\.(\d{2,3}[A-Z]?)(?:\.(\d{3,4}[A-Z]?))?\b|^CHAPTER\s+(\d{1,2}[A-Z]?)\.(\d{2,3}[A-Z]?)\s+RCW\b|^TITLE\s+(\d{1,2}[A-Z]?)\s+RCW\b/,
  fnPackage: /^(?:PACKAGE\s*ID\s*=?|PACKAGE|FN\s*#?|FISCAL\s+NOTE(?:\s+PACKAGE)?\s*#?)\s*(\d{3,8})\b/,
  initiative: /^I-?\s?(\d{3,4})\b/,
  drafter: /\b([HS])-?(\d{4}\.(?:\d+|E))\b/,
  amendmentOnly:
    /^(?:(\d{1,4})((?:-S[23]?)?(?:\.E[23]?)?)\s+)?AM([HSC])\s+([A-Z&]+)\s+(?:([HS])-?(\d{4}\.(?:\d+|E))|([A-Z]{3,5})\s+(\d{1,4}))\b/,
  bill: new RegExp(
    `^(?:((?:19|20)\\d\\d)(?:-(?:(?:19|20)?\\d\\d))?\\s+(?=[23ES]*(?:${TYPES})))?` +
      `([23]?E)?([23]?S)?(${TYPES})?[\\s-]*(\\d{1,4})(-S[23]?)?(\\.(?:E[23]?|PL|SL))?(?![\\d.])`,
  ),
  bienniumTail:
    /^\s*[(,]?\s*(?:FOR\s+|OF\s+)?((?:19|20)\d\d)(?:\s*-\s*((?:19|20)?\d\d))?(?:\s+(?:REGULAR|SPECIAL|1ST|2ND|3RD)?\s*SESSION)?\s*\)?/,
  amendmentTail:
    /^\s*,?\s*(AS\s+AMENDED\s+BY\s+)?(?:(AMENDMENT|AMD)\s+(?:NO\.?\s*)?|AM([HSC])\s+(?:([A-Z&]+)\s+)?)?(?:([HS])-?(\d{4}\.(?:\d+|E))|(?:([A-Z]{3,5})\s+)?(\d{1,4}))\b/,
  trailingType: new RegExp(`^\\s+([23]?E)?([23]?S)?(${TYPES})\\b`),
};

export function parse(input: string, opts: ParseOptions): ParseResult {
  const s = normalize(input);
  const done = (ref: Ref | null, consumed: number): ParseResult => ({
    ref,
    remainder: s.slice(consumed).replace(/^[\s,;)]+/, ''),
    normalized: s,
  });
  if (!s) return done(null, 0);

  let m: RegExpExecArray | null;
  if ((m = RE.sessionLaw.exec(s))) {
    return done(
      { kind: 'session_law', chapter: Number(m[1] ?? m[5]), year: Number(m[2] ?? m[3] ?? m[4]), pv: !!m[6] },
      m[0].length,
    );
  }
  if ((m = RE.rcw.exec(s))) {
    const title = (m[1] ?? m[4] ?? m[6]) as string;
    const chapter = m[2] ?? m[5];
    const section = m[3];
    const cite = [title, chapter, section].filter(Boolean).join('.');
    const ref: RcwRef = { kind: 'rcw', title, cite };
    if (chapter) ref.chapter = `${title}.${chapter}`;
    if (section) ref.section = cite;
    return done(ref, m[0].length);
  }
  if ((m = RE.fnPackage.exec(s))) return done({ kind: 'fiscal_note_package', packageId: Number(m[1]) }, m[0].length);
  if ((m = RE.initiative.exec(s))) return done({ kind: 'initiative', number: Number(m[1]) }, m[0].length);

  if ((m = RE.amendmentOnly.exec(s))) {
    const amd = amendmentRef(m[3] as Chamber | 'C', m[4], m[5], m[6], m[7], m[8]);
    if (!m[1]) return done(amd, m[0].length);
    const n = Number(m[1]);
    const t = typeForNumber(n);
    const lsub = /-S[23]?/.exec(m[2] ?? '')?.[0];
    const leng = /\.E[23]?/.exec(m[2] ?? '')?.[0];
    return done(
      {
        kind: 'bill',
        biennium: opts.currentBiennium,
        bienniumExplicit: false,
        chamber: chamberOf(t.type),
        type: t.type,
        number: n,
        versionCode: versionCode(undefined, undefined, lsub, leng),
        versionExplicit: !!(lsub || leng),
        amendment: amd,
        confidence: 'inferred',
        warnings: [],
      },
      m[0].length,
    );
  }
  if ((m = RE.drafter.exec(s)) && m.index === 0) {
    return done({ kind: 'amendment', chamber: m[1] as Chamber, drafterNumber: `${m[1]}${m[2]}` }, m[0].length);
  }

  if ((m = RE.bill.exec(s))) {
    const y0 = m[1];
    let eng = m[2];
    let sub = m[3];
    let typeStr = m[4];
    const numStr = m[5] as string;
    const lsub = m[6];
    const leng = m[7];
    const number = Number(numStr);
    const warnings: string[] = [];
    let end = m[0].length;
    if (!typeStr) {
      const tt = RE.trailingType.exec(s.slice(end));
      if (tt) {
        eng = eng ?? tt[1];
        sub = sub ?? tt[2];
        typeStr = tt[3];
        end += tt[0].length;
      }
    }
    let type = typeStr as BillType | undefined;
    let confidence: 'exact' | 'inferred' = 'exact';
    const inferred = typeForNumber(number);
    if (!type) {
      type = inferred.type;
      confidence = 'inferred';
      if (!inferred.inRange) warnings.push(`number ${number} is outside every known range`);
      if (number >= 1900 && number <= 2099 && !eng && !sub && !lsub && !leng) warnings.push('may be a year');
    } else if (inferred.inRange && HOUSE.has(type) !== HOUSE.has(inferred.type)) {
      warnings.push(`number ${number} is outside the usual ${HOUSE.has(type) ? 'House' : 'Senate'} range`);
    } else if (!inferred.inRange) {
      warnings.push(`number ${number} is outside every known range`);
    }
    let biennium = y0 ? bienniumFromMatch(y0) : opts.currentBiennium;
    let bienniumExplicit = !!y0;
    const bt = RE.bienniumTail.exec(s.slice(end));
    if (bt) {
      biennium = bienniumFromMatch(bt[1] as string);
      bienniumExplicit = true;
      end += bt[0].length;
    }
    const at = RE.amendmentTail.exec(s.slice(end));
    let amendment: AmendmentRef | undefined;
    if (at && (at[1] || at[2] || at[3] || at[6])) {
      amendment = amendmentRef((at[3] ?? at[5]) as Chamber | 'C' | undefined, at[4], at[5], at[6], at[7], at[8]);
      end += at[0].length;
    }
    const code = versionCode(eng, sub, lsub, leng);
    const ref: BillRef = {
      kind: 'bill',
      biennium,
      bienniumExplicit,
      chamber: chamberOf(type),
      type,
      number,
      versionCode: code,
      versionExplicit: !!(eng || sub || lsub || leng),
      confidence,
      warnings,
    };
    if (amendment) ref.amendment = amendment;
    return done(ref, end);
  }
  return done(null, 0);
}

function amendmentRef(
  chamber: Chamber | 'C' | undefined,
  code: string | undefined,
  drafterChamber: string | undefined,
  drafterNo: string | undefined,
  initials: string | undefined,
  amdNo: string | undefined,
): AmendmentRef {
  const a: AmendmentRef = { kind: 'amendment' };
  if (chamber) a.chamber = chamber;
  if (code) a.committeeOrSponsor = code;
  if (drafterNo) a.drafterNumber = `${drafterChamber}${drafterNo}`;
  if (initials) a.initials = initials;
  if (amdNo) a.amdNumber = Number(amdNo);
  return a;
}

/** Every reference in a string, in order. */
export function parseAll(input: string, opts: ParseOptions): Ref[] {
  const out: Ref[] = [];
  let rest = input;
  for (let i = 0; i < 20 && rest; i++) {
    const r = parse(rest, opts);
    if (!r.ref) {
      const cut = rest.search(/[\s,;]/);
      if (cut < 0) break;
      rest = rest.slice(cut + 1);
      continue;
    }
    out.push(r.ref);
    rest = r.remainder;
  }
  return out;
}

/** True when the whole input is one reference (used by the search box to decide on redirect). */
export function isBareReference(input: string, opts: ParseOptions): boolean {
  const r = parse(input, opts);
  return !!r.ref && r.remainder === '';
}

export const RCW_BASE = 'https://app.leg.wa.gov/RCW/default.aspx?cite=';

/** App-relative URL for a bill or amendment reference; absolute URL for external references. */
export function urlFor(ref: Ref): string | null {
  switch (ref.kind) {
    case 'bill': {
      const base = `/bills/${ref.biennium}/${ref.type}${ref.number}`;
      if (ref.amendment?.drafterNumber) {
        return `${base}/${ref.versionCode}?amendment=${encodeURIComponent(ref.amendment.drafterNumber)}`;
      }
      return ref.versionExplicit ? `${base}/${ref.versionCode}` : base;
    }
    case 'rcw':
      return `${RCW_BASE}${ref.cite}`;
    case 'session_law':
      return `https://app.leg.wa.gov/billsummary?Chapter=${ref.chapter}&Year=${ref.year}`;
    case 'fiscal_note_package':
      return `https://fnspublic.ofm.wa.gov/FNSPublicSearch/GetPDF?packageID=${ref.packageId}`;
    case 'initiative':
      return `https://app.leg.wa.gov/billinfo/initiatives.aspx`;
    case 'amendment':
      return null;
  }
}

/** Lawfilesext URL for a bill version file. Directory depends on type, chamber, and stage. */
export function lawfilesUrl(
  biennium: string,
  type: BillType,
  number: number,
  code: string,
  format: 'Pdf' | 'Htm' | 'Xml' = 'Xml',
): string {
  const v = decodeVersion(code);
  const chamber = chamberOf(type) === 'H' ? 'House' : 'Senate';
  let dir: string;
  if (v.stage === 'SL') dir = `Session Laws/${chamber}`;
  else if (v.stage === 'PL') dir = `${chamber} Passed Legislature`;
  else {
    const kind: Record<BillType, string> = {
      HB: 'Bills',
      SB: 'Bills',
      HJR: 'Joint Resolutions',
      SJR: 'Joint Resolutions',
      HJM: 'Joint Memorials',
      SJM: 'Joint Memorials',
      HCR: 'Concurrent Resolutions',
      SCR: 'Concurrent Resolutions',
      HR: 'Resolutions',
      SR: 'Resolutions',
    };
    dir = `${chamber} ${kind[type]}`;
  }
  const ext = format.toLowerCase();
  return `https://lawfilesext.leg.wa.gov/biennium/${biennium}/${format}/Bills/${encodeURI(dir)}/${number}${lawfilesSuffix(code)}.${ext}`;
}
