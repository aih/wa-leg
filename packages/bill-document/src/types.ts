// Bill Document and Amendment Document types. Mirror of schemas/*.json (design/research/bill-viewer.md section 3).

export type Chamber = 'H' | 'S';
export type BillTypeCode = 'B' | 'JR' | 'JM' | 'CR' | 'R' | 'I';

export interface CiteRef {
  kind: 'rcw' | 'rcw-chapter' | 'rcw-title' | 'session-law' | 'bill-section' | 'wac' | 'usc' | 'cfr' | 'other';
  text: string;
  cite?: string;
  href?: string;
  targetId?: string;
}

export type RunType = 'text' | 'ins' | 'del' | 'cite';
export type BillMark = 'ins' | 'del';

export interface Run {
  t: RunType;
  text: string;
  cite?: CiteRef;
  /** On a cite run: whether the cite sits inside inserted or struck text. */
  mark?: BillMark;
  line?: number;
  page?: number;
}

export type BlockKind = 'subsection' | 'paragraph' | 'subparagraph' | 'item' | 'subitem' | 'unnumbered' | 'table' | 'chapeau';

export interface LineSpan {
  pageStart: number;
  lineStart: number;
  pageEnd: number;
  lineEnd: number;
}

export interface TableCell {
  runs: Run[];
  colspan?: number;
  rowspan?: number;
  align?: 'left' | 'center' | 'right';
  header?: boolean;
}

export interface TableData {
  rows: TableCell[][];
  caption?: string;
}

export interface Block {
  id: string;
  label?: string;
  labelMark?: BillMark;
  level: number;
  kind: BlockKind;
  runs: Run[];
  children: Block[];
  lines?: LineSpan;
  /** For kind = table. */
  table?: TableData;
  /** Rendering hints carried from the source. */
  align?: 'left' | 'center' | 'right';
}

export type SectionKind =
  | 'amendatory'
  | 'new'
  | 'repealer'
  | 'effective-date'
  | 'emergency'
  | 'severability'
  | 'expiration'
  | 'intent'
  | 'appropriation'
  | 'contingent'
  | 'other';

export type SectionAction = 'amend' | 'reenact-amend' | 'add' | 'repeal' | 'decodify' | 'recodify';

/** XML BillSection[@type][@action] as found in the source, kept for the API enum. */
export type SourceSectionKind = 'new' | 'addsect' | 'addchap' | 'amend' | 'remd' | 'amenduncod' | 'repeal' | 'effdate' | 'emerg' | 'expdate' | 'other';

export interface RepealedEntry {
  cite: string;
  caption?: string;
  history?: string;
  href?: string;
}

export interface SectionTarget {
  action: SectionAction;
  cite?: string;
  chapter?: string;
  title?: string;
  uncodified?: string;
  caption?: string;
  history?: string;
  href?: string;
  repealed?: RepealedEntry[];
}

export interface BillSection {
  id: string;
  num: string;
  label: string;
  isNewSection: boolean;
  kind: SectionKind;
  /** The source vocabulary: BillSection[@type][@action] mapped to one token. */
  sourceKind: SourceSectionKind;
  identity: string;
  heading?: string;
  /** Part label this section sits under, e.g. "PART I" and its heading. */
  part?: { label: string; heading?: string };
  target?: SectionTarget;
  introText?: Run[];
  blocks: Block[];
  notes?: string[];
  lines?: LineSpan;
  textHash: string;
  changeSummary?: { insWords: number; delWords: number };
  /** Section number is fixed (part-numbered bills). */
  fixedNumber?: boolean;
  veto?: boolean;
}

export interface TitleAction {
  kind:
    | 'amending'
    | 'reenacting-and-amending'
    | 'adding-section'
    | 'adding-chapter'
    | 'repealing'
    | 'decodifying'
    | 'recodifying'
    | 'creating-new-sections'
    | 'effective-date'
    | 'emergency'
    | 'expiration'
    | 'appropriation'
    | 'other';
  cites?: CiteRef[];
  text?: string;
}

export interface BillHeader {
  title: string;
  relatingTo?: string;
  sponsors?: string[];
  byRequestOf?: string;
  briefDescription?: string;
  readFirstTime?: string;
  prefiledDate?: string;
  referredTo?: string;
  requestNumber?: string;
  shortBillId?: string;
  longBillId?: string;
  legislature?: string;
  session?: string;
  asAmended?: string;
  titleActions?: TitleAction[];
  parts?: { label: string; heading?: string }[];
}

export interface Certificate {
  chapter?: number;
  year?: number;
  caption?: string;
  effectiveDate?: string;
  partialVeto?: boolean;
  passed?: { chamber: Chamber; date: string; yeas?: number; nays?: number }[];
  approvedDate?: string;
  filedDate?: string;
  governor?: string;
  history?: string[];
}

export interface RcwAffected {
  cite: string;
  chapter?: string;
  action: 'amend' | 'reenact-amend' | 'add' | 'repeal' | 'decodify' | 'recodify' | 'reference';
  sectionIds: string[];
  href?: string;
  caption?: string;
}

export interface VersionInfo {
  code: string;
  label: string;
  seq: number;
  date?: string;
  amendmentIds?: string[];
}

export interface Provenance {
  fetchedAt: string;
  parser: string;
  parserVersion: string;
  warnings?: string[];
  hasLineNumbers?: boolean;
  sourceUrl?: string;
}

export interface BillDocument {
  schemaVersion: '1.0';
  bill: {
    biennium: string;
    chamber: Chamber;
    type: BillTypeCode;
    number: number;
    id: string;
    shortTitle?: string;
    billPageUrl?: string;
  };
  version: {
    code: string;
    label: string;
    seq: number;
    date?: string;
    sourceUrls?: { htm?: string; pdf?: string; xml?: string };
    sourceHash?: string;
    isCurrent?: boolean;
  };
  versions?: VersionInfo[];
  header: BillHeader;
  sections: BillSection[];
  rcwAffected?: RcwAffected[];
  certificate?: Certificate;
  provenance: Provenance;
}

export type AmendmentKind = 'striking' | 'page-line' | 'title';
export type AmendmentScope = 'floor' | 'committee' | 'conference';
export type AmendmentStatus = 'pending' | 'adopted' | 'failed' | 'withdrawn' | 'ruled-out-of-order' | 'unknown';

export type InstructionOp =
  | 'strike-insert'
  | 'strike'
  | 'insert'
  | 'strike-section'
  | 'insert-section'
  | 'strike-all-insert'
  | 'renumber'
  | 'title-strike-insert'
  | 'title-insert'
  | 'correct-internal-references'
  | 'other';

export interface InstructionLocation {
  page?: number;
  line?: number;
  lineEnd?: number;
  pageEnd?: number;
  anchor?: 'after' | 'before' | 'beginning' | 'end';
  anchorText?: string;
  sectionNum?: string;
  title?: boolean;
}

export interface Instruction {
  id: string;
  seq: number;
  text: string;
  op: InstructionOp;
  location: InstructionLocation;
  strikeText?: string;
  insertText?: string;
  insertBlocks?: Block[];
  insertSections?: BillSection[];
  resolved?: {
    sectionId?: string;
    blockId?: string;
    runIndex?: number;
    charStart?: number;
    charEnd?: number;
    confidence: 'exact' | 'line-only' | 'text-only' | 'unresolved';
    note?: string;
  };
}

export interface AmendmentDocument {
  schemaVersion: '1.0';
  id: string;
  bill: { biennium: string; id: string };
  baseVersion: string;
  kind: AmendmentKind;
  scope?: AmendmentScope;
  chamber?: Chamber;
  sponsor?: string;
  committee?: string;
  drafterCode?: string;
  floorNumber?: string;
  status?: AmendmentStatus;
  actionDate?: string;
  effect?: string;
  sourceUrls?: { htm?: string; pdf?: string; xml?: string };
  sourceHash?: string;
  body?: { header?: { title?: string; titleActions?: TitleAction[] }; sections: BillSection[] };
  instructions?: Instruction[];
  provenance: Provenance;
}

/** Citation emitted by the viewer and stored by the note editor (ARCHITECTURE.md "Web app"). */
export interface BillCitation {
  billKey: string;
  versionCode: string;
  versionLabel: string;
  sectionId: string;
  blockId?: string;
  label?: string;
  citation: string;
  href: string;
  text?: string;
  amendmentId?: string;
}

export interface CiteEvent {
  bill: { biennium: string; id: string };
  versionCode: string;
  sectionId: string;
  sectionNum: string;
  blockId: string | null;
  label: string | null;
  range: { start: number; end: number } | null;
  text: string;
  citation: string;
  href: string;
  amendmentId?: string;
}
