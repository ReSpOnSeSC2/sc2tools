import type { LockerState, LockerStudent } from "./lockerRosterModel";

export const WORKSHEET_BLOCK_TYPES = {
  mc: "Multiple choice", long: "Long answer", scale: "Scale 1–10", image: "Annotated image", replay: "Replay request",
} as const;

export type WorksheetBlockType = keyof typeof WORKSHEET_BLOCK_TYPES;
export type WorksheetPrompt = {
  ty: WorksheetBlockType;
  q: string;
  opts?: string[];
  img?: string | null;
};
export type WorksheetBlock = Record<string, unknown> & WorksheetPrompt & { id: string };
export type WorksheetAnswer = string | number | { count: number };
export type WorksheetAnswers = Record<string, WorksheetAnswer>;
export type Worksheet = Record<string, unknown> & {
  id: string;
  title: string;
  state: "draft" | "sent" | "submitted";
  blocks: WorksheetBlock[];
  answers: WorksheetAnswers;
  submittedAt?: string;
};
export type WorksheetTemplate = Record<string, unknown> & { id: string; title: string; blocks: WorksheetBlock[] };
export type WorksheetReplay = {
  id: string;
  name: string;
  size: number;
  b64: string;
  build: string;
  at: string;
  exported: false;
};

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function isWorksheetBlockType(value: unknown): value is WorksheetBlockType {
  return typeof value === "string" && Object.hasOwn(WORKSHEET_BLOCK_TYPES, value);
}

function isWorksheetBlock(value: unknown): value is WorksheetBlock {
  return object(value) && typeof value.id === "string" && isWorksheetBlockType(value.ty) && typeof value.q === "string"
    && (value.opts === undefined || Array.isArray(value.opts) && value.opts.every(option => typeof option === "string"));
}

export function isWorksheet(value: unknown): value is Worksheet {
  return object(value) && typeof value.id === "string" && typeof value.title === "string"
    && (value.state === "draft" || value.state === "sent" || value.state === "submitted")
    && Array.isArray(value.blocks) && value.blocks.every(isWorksheetBlock) && object(value.answers);
}

export function worksheetsFor(student: LockerStudent) {
  return array(student.worksheets).filter(isWorksheet);
}

export function templatesFor(state: LockerState) {
  return array(state.wsTemplates).filter((value): value is WorksheetTemplate => object(value)
    && typeof value.id === "string" && typeof value.title === "string" && Array.isArray(value.blocks) && value.blocks.every(isWorksheetBlock));
}

/** Preserve malformed or newer rows and every field outside the addressed view. */
export function withWorksheet(state: LockerState, studentId: string, id: string, value: Worksheet | null): LockerState {
  return { ...state, students: (state.students ?? []).map(student => {
    if (student?.id !== studentId) return student;
    const worksheets = array(student.worksheets);
    if (!worksheets.some(row => object(row) && row.id === id)) return value ? { ...student, worksheets: [value, ...worksheets] } : student;
    return { ...student, worksheets: worksheets.flatMap(row => object(row) && row.id === id ? value ? [value] : [] : [row]) };
  }) };
}

export function withWorksheetTemplate(state: LockerState, id: string, value: WorksheetTemplate | null): LockerState {
  const templates = array(state.wsTemplates);
  return { ...state, wsTemplates: value ? [value, ...templates.filter(row => !object(row) || row.id !== id)]
    : templates.filter(row => !object(row) || row.id !== id) };
}

export function withWorksheetSubmission(state: LockerState, studentId: string, worksheet: Worksheet,
  answers: WorksheetAnswers, replays: WorksheetReplay[], submittedAt: string): LockerState {
  const next = withWorksheet(state, studentId, worksheet.id, { ...worksheet, state: "submitted", answers, submittedAt });
  if (!replays.length) return next;
  return { ...next, students: next.students?.map(student => student?.id === studentId
    ? { ...student, submissions: [...array(student.submissions), ...replays] } : student) };
}

export function newWorksheet(title: string, blocks: readonly WorksheetPrompt[] = [], id: string = crypto.randomUUID()): Worksheet {
  return { id, title, state: "draft", blocks: blocks.map(block => ({ ...structuredClone(block), id: crypto.randomUUID() })), answers: {} };
}

export function worksheetValidation(worksheet: Worksheet) {
  if (!worksheet.title.trim()) return "Give the worksheet a title before sending.";
  if (!worksheet.blocks.length) return "Add at least one question before sending.";
  const empty = worksheet.blocks.findIndex(block => !block.q.trim());
  if (empty >= 0) return `Question ${empty + 1} needs text before sending.`;
  const invalidChoice = worksheet.blocks.findIndex(block => block.ty === "mc" && (Array.isArray(block.opts) ? block.opts : []).filter(option => typeof option === "string" && option.trim()).length < 2);
  if (invalidChoice >= 0) return `Multiple-choice question ${invalidChoice + 1} needs at least two options.`;
  return null;
}

/** Only inline raster data produced by the Classic or React annotation editor. */
export function worksheetImage(value: unknown): string | null {
  return typeof value === "string" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
}
