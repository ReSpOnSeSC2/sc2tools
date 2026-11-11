"use strict";

const { isDeepStrictEqual } = require("node:util");

const TYPES = new Set(["mc", "long", "scale", "image", "replay"]);
const MAX_REPLAY_BYTES = 900 * 1024;
const RASTER = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** @typedef {Record<string, any>} Row */
/** @typedef {{role: string, studentId?: string, coachId?: string}} WorksheetActor */
const row = (/** @type {unknown} */ value) => value && typeof value === "object" && !Array.isArray(value) ? /** @type {Row} */ (value) : null;
const rows = (/** @type {unknown} */ value) => /** @type {Row[]} */ (Array.isArray(value) ? value : []);
const safeId = (/** @type {unknown} */ value) => typeof value === "string" && ID.test(value);

/** Strip unpublished work before the ordinary student projection collects assets.
 * @param {Row} state @param {WorksheetActor} actor */
function studentWorksheetRead(state, actor) {
  if (actor.role !== "student") return state;
  const student = rows(state.students).find(item => item?.id === actor.studentId);
  if (!student || !Array.isArray(student.worksheets)) return { ...state, students: student ? [student] : [] };
  return { ...state, students: [{ ...student,
    worksheets: rows(student.worksheets).filter(item => item?.state === "sent" || item?.state === "submitted"),
  }] };
}

/** @param {Row|null} incoming @param {Row|undefined} [previous] */
function draftBlock(incoming, previous) {
  if (!incoming || !safeId(incoming.id) || !TYPES.has(incoming.ty) || typeof incoming.q !== "string") return null;
  const next = { ...(previous || incoming), id: incoming.id, ty: incoming.ty, q: incoming.q };
  if (incoming.ty === "mc") {
    if (!Array.isArray(incoming.opts) || !incoming.opts.every((/** @type {unknown} */ item) => typeof item === "string")) return null;
    return { ...next, opts: incoming.opts };
  }
  if (incoming.ty === "image") {
    if (incoming.img != null && (typeof incoming.img !== "string" || !RASTER.test(incoming.img))) return null;
    return { ...next, img: incoming.img ?? null };
  }
  return next;
}

/** @param {Row} incoming @param {Row|undefined} previous */
function draftBlocks(incoming, previous) {
  if (!Array.isArray(incoming.blocks)) return null;
  const before = new Map(rows(previous?.blocks).filter(Boolean).map(item => [item.id, item]));
  const ids = new Set();
  const blocks = [];
  for (const raw of incoming.blocks) {
    const block = draftBlock(row(raw), before.get(raw?.id));
    if (!block || ids.has(block.id)) return null;
    ids.add(block.id); blocks.push(block);
  }
  return blocks;
}

/** @param {Row} incoming @param {Row|undefined} [previous] */
function authorWorksheet(incoming, previous) {
  if (!safeId(incoming.id) || typeof incoming.title !== "string" || !["draft", "sent"].includes(incoming.state)) return null;
  const blocks = draftBlocks(incoming, previous);
  if (!blocks) return null;
  if (incoming.state === "sent" && (!incoming.title.trim() || !blocks.length || blocks.some(block => !block.q.trim()
    || block.ty === "mc" && (!("opts" in block) || !Array.isArray(block.opts)
      || block.opts.filter((/** @type {string} */ item) => item.trim()).length < 2)))) return null;
  const authorData = { ...incoming };
  delete authorData.answers;
  delete authorData.submittedAt;
  return { ...(previous || authorData), id: incoming.id, title: incoming.title, blocks, state: incoming.state,
    answers: previous?.answers ?? {} };
}

/** Insert a new or restored row at the requested position without moving untouched rows.
 * @param {Row[]} retained @param {Row[]} added @param {Row[]} requested */
function insertAuthoredRows(retained, added, requested) {
  const positions = new Map(requested.map((item, index) => [item?.id, index]));
  for (const item of added) retained.splice(positions.get(item.id) ?? retained.length, 0, item);
  return retained;
}

/** @param {Row[]} previous @param {Row[]} requested */
function authoredWorksheets(previous, requested) {
  const known = new Set(previous.map(item => item?.id));
  const wanted = new Map(requested.filter(item => safeId(item?.id)).map(item => [item.id, item]));
  const added = [...wanted.values()].filter(item => !known.has(item.id))
    .flatMap(item => { const authored = authorWorksheet(item); return authored ? [authored] : []; });
  const retained = previous.flatMap(item => {
    const candidate = wanted.get(item?.id);
    if (!item || !safeId(item.id) || item.state === "submitted") return [item];
    if (!candidate) return item.state === "draft" || item.state === "sent" ? [] : [item];
    if (isDeepStrictEqual(item, candidate)) return [item];
    // Sent prompts remain fixed. A backup may restore the unsent draft,
    // but a completed student submission always belongs to the student.
    if (item.state === "sent" && candidate.state !== "draft") return [item];
    return [authorWorksheet(candidate, item) || item];
  });
  return insertAuthoredRows(retained, added, requested);
}

/** @param {Row[]} previous @param {Row[]} requested */
function authoredTemplates(previous, requested) {
  const known = new Set(previous.map(item => item?.id));
  const wanted = new Map(requested.filter(item => safeId(item?.id)).map(item => [item.id, item]));
  const added = [...wanted.values()].flatMap(item => {
    if (known.has(item.id) || typeof item.title !== "string") return [];
    const blocks = draftBlocks(item, undefined);
    return blocks ? [{ ...item, blocks }] : [];
  });
  return insertAuthoredRows(previous.filter(item => !safeId(item?.id) || wanted.has(item.id)), added, requested);
}

/** @param {Row} state @param {Row} incoming @param {WorksheetActor} actor */
function mergeAuthorWrite(state, incoming, actor) {
  const wanted = new Map(rows(incoming.students).filter(item => safeId(item?.id)).map(item => [item.id, item]));
  const students = rows(state.students).map(student => {
    if (!student || actor.role !== "admin" && student.coachId !== actor.coachId) return student;
    const candidate = wanted.get(student.id);
    return Array.isArray(candidate?.worksheets) ? { ...student, worksheets: authoredWorksheets(rows(student.worksheets), candidate.worksheets) } : student;
  });
  const next = { ...state, ...(Array.isArray(state.students) ? { students } : {}),
    ...(Array.isArray(incoming.wsTemplates) ? { wsTemplates: authoredTemplates(rows(state.wsTemplates), incoming.wsTemplates) } : {}) };
  return isDeepStrictEqual(next, state) ? null : next;
}

/** @param {Row} item @param {string} label @param {string} worksheetId */
function worksheetReplay(item, label, worksheetId) {
  if (!item || !safeId(item.id) || typeof item.name !== "string" || !/^[^\u0000-\u001f/\\]+\.SC2Replay$/i.test(item.name)
    || !Number.isInteger(item.size) || item.size < 1 || item.size > MAX_REPLAY_BYTES || item.build !== label
    || typeof item.b64 !== "string" || item.b64.length !== 4 * Math.ceil(item.size / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64)
    || Buffer.byteLength(item.b64, "base64") !== item.size || typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at))) return null;
  return { id: item.id, name: item.name, size: item.size, b64: item.b64, build: label, at: item.at, exported: false, worksheetId };
}

/** @param {Row} worksheet @param {Row} candidate */
function worksheetAnswers(worksheet, candidate) {
  const input = row(candidate.answers);
  if (!input) return null;
  /** @type {[string, string|number|{count:number}][]} */ const entries = [];
  let replayCount = 0;
  for (const block of rows(worksheet.blocks)) {
    if (!safeId(block?.id) || !Object.hasOwn(input, block.id)) continue;
    const answer = input[block.id];
    if (block.ty === "long" || block.ty === "image") {
      if (typeof answer !== "string") return null;
      entries.push([block.id, answer]);
    } else if (block.ty === "mc" || block.ty === "scale") {
      const valid = Number.isInteger(answer) && (block.ty === "mc" ? answer >= 0 && answer < (block.opts || []).length : answer >= 1 && answer <= 10);
      if (!valid) return null;
      entries.push([block.id, answer]);
    } else if (block.ty === "replay") {
      if (!Number.isSafeInteger(answer?.count) || answer.count < 0) return null;
      replayCount += answer.count;
      entries.push([block.id, { count: answer.count }]);
    }
  }
  return { answers: Object.fromEntries(entries), replayCount };
}

/** @param {Row} student @param {Row} candidate @param {Row} worksheet @param {Row} target */
function studentWorksheetChange(student, candidate, worksheet, target) {
  const label = `worksheet: ${worksheet.title}`;
  const submissions = rows(student.submissions);
  const wanted = rows(candidate.submissions);
  if (worksheet.state === "submitted") {
    const wantedIds = new Set(wanted.map(item => item?.id));
    const previous = { ...worksheet };
    delete previous.submittedAt;
    return { worksheet: { ...previous, state: "sent", answers: {} },
      submissions: submissions.filter(item => item?.worksheetId !== worksheet.id || wantedIds.has(item.id)) };
  }
  const parsed = worksheetAnswers(worksheet, target);
  if (!parsed) return null;
  const seen = new Set(submissions.map(item => item?.id));
  const appended = [];
  for (const item of wanted) {
    if (seen.has(item?.id)) continue;
    const replay = worksheetReplay(item, label, worksheet.id);
    if (!replay) return null;
    seen.add(replay.id); appended.push(replay);
  }
  if (appended.length !== parsed.replayCount) return null;
  return { worksheet: { ...worksheet, state: "submitted", answers: parsed.answers, submittedAt: new Date().toISOString() },
    submissions: [...submissions, ...appended] };
}

/** @param {Row} state @param {Row} incoming @param {WorksheetActor} actor */
function mergeStudentWorksheetWrite(state, incoming, actor) {
  const students = rows(state.students);
  const student = students.find(item => item?.id === actor.studentId);
  const candidate = rows(incoming.students).find(item => item?.id === actor.studentId);
  if (!student || !candidate) return null;
  const previous = rows(student.worksheets);
  const wanted = new Map(rows(candidate.worksheets).filter(item => safeId(item?.id)).map(item => [item.id, item]));
  const changed = previous.filter(item => item && (item.state === "sent" && wanted.get(item.id)?.state === "submitted"
    || item.state === "submitted" && wanted.get(item.id)?.state === "sent"));
  if (changed.length !== 1) return null;
  const current = changed[0];
  const target = wanted.get(current.id);
  if (!target) return null;
  const next = studentWorksheetChange(student, candidate, current, target);
  if (!next) return null;
  const worksheets = previous.map(item => item === current ? next.worksheet : item);
  return { ...state, students: students.map(item => item === student ? { ...student, worksheets, submissions: next.submissions } : item) };
}

/** @param {Row} state @param {Row} incoming @param {WorksheetActor} actor */
function mergeWorksheetWrite(state, incoming, actor) {
  if (actor.role === "student" && actor.studentId) return mergeStudentWorksheetWrite(state, incoming, actor);
  if (actor.role === "admin" || actor.role === "coach" && actor.coachId) return mergeAuthorWrite(state, incoming, actor);
  return null;
}

/** Classic saves the complete student record. Retain coach drafts and
 * sent prompts when the student sends their own worksheet answers.
 * @param {unknown} previous @param {unknown} requested */
function mergeClassicStudentWorksheets(previous, requested) {
  if (!Array.isArray(previous)) return previous;
  const incoming = new Map(rows(requested).filter(item => safeId(item?.id)).map(item => [item.id, item]));
  return rows(previous).map(worksheet => {
    if (worksheet?.state !== "sent") return worksheet;
    const next = incoming.get(worksheet.id);
    if (next?.state !== "submitted") return worksheet;
    const parsed = worksheetAnswers(worksheet, next);
    return parsed ? { ...worksheet, state: "submitted", answers: parsed.answers, submittedAt: new Date().toISOString() } : worksheet;
  });
}

/** Keep links from the authoritative copy when Classic saves a student record.
 * Classic can add legacy replay records, but cannot assign them to a worksheet.
 * @param {Row} before @param {Row} after */
function preserveWorksheetReplayLinks(before, after) {
  if (!Array.isArray(after.students)) return after;
  const previous = new Map(rows(before.students).filter(Boolean).map(student => [student.id, student]));
  const students = rows(after.students).map(student => {
    if (!Array.isArray(student?.submissions)) return student;
    const links = new Map(rows(previous.get(student.id)?.submissions).filter(item => safeId(item?.worksheetId))
      .map(item => [item.id, item.worksheetId]));
    const submissions = rows(student.submissions).map(item => {
      if (!row(item)) return item;
      const worksheetId = links.get(item.id);
      if (worksheetId) return item.worksheetId === worksheetId ? item : { ...item, worksheetId };
      if (!Object.hasOwn(item, "worksheetId")) return item;
      const legacy = { ...item };
      delete legacy.worksheetId;
      return legacy;
    });
    return { ...student, submissions };
  });
  return { ...after, students };
}

module.exports = { mergeClassicStudentWorksheets, mergeWorksheetWrite, preserveWorksheetReplayLinks, studentWorksheetRead };
