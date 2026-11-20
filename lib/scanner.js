// Notes Scanner: photos of handwritten pages in, one clean entry saved to the Brain out.
// Reading is done by Claude (vision) on the server. Pages are saved first and read in the
// background, so the entry still gets filed if the phone is closed mid-read.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { save } from "./store.js";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const NOTES_DIR = path.join(DATA_DIR, "notes");
const API_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const MODEL = () => process.env.SCANNER_MODEL || "claude-opus-5-5";
// Use whichever name the key was saved under in Railway.
const apiKey = () => ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_KEY", "CLAUDE_KEY"].map((k) => (process.env[k] || "").trim()).find(Boolean) || "";

export const SCAN_TYPES = ["idea", "meeting", "call", "study", "plan", "log"];
export const MAX_PAGES = 6;
const MAX_IMAGE_BYTES = 4.5e6;
const ENTITY_KINDS = ["person", "company", "carrier", "place", "phone", "email", "money", "date", "number", "other"];

// Shorthand that shows up in his notes. Fixes he makes in the app get added on top of this.
const BASE_GLOSSARY = [
  ["UHL", "United Home Life"],
  ["Combined", "Combined Insurance (Chubb)"],
  ["AmAm", "American Amicable"],
  ["Pol. Falcons / PF", "Polish Falcons"],
  ["FE", "final expense"],
  ["IUL", "indexed universal life"],
  ["MP", "mortgage protection"],
  ["LO", "loan officer"],
  ["NMLS", "NMLS (mortgage licensing)"],
  ["re", "about"],
  ["w/", "with"],
  ["b/c", "because"],
  ["appt", "appointment"],
  ["f/u", "follow up"],
];

let getBrain = null;
let running = 0;
const queue = [];

const str = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
const nid = () => crypto.randomBytes(6).toString("hex");

function notes() {
  const b = getBrain();
  if (!Array.isArray(b.notes)) b.notes = [];
  if (!Array.isArray(b.scanGlossary)) b.scanGlossary = [];
  return b.notes;
}
function findNote(id) { return notes().find((n) => n.id === String(id || "")); }
function photoPath(id, i) { return path.join(NOTES_DIR, `${id}-${i}`); }

export function initScanner(brainGetter) {
  getBrain = brainGetter;
  try { fs.mkdirSync(NOTES_DIR, { recursive: true }); } catch {}
  // Anything that was mid-read when the server restarted gets picked back up.
  for (const n of notes()) if (n.status === "reading") enqueue(n.id);
}

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

// ---------- public API used by server.js ----------

export function createScan(body) {
  const pages = Array.isArray(body.pages) ? body.pages : [];
  if (!pages.length) return { status: 400, data: { error: "Snap at least one page." } };
  if (pages.length > MAX_PAGES) return { status: 400, data: { error: `Up to ${MAX_PAGES} pages at a time.` } };
  const bufs = [];
  for (const p of pages) {
    const raw = String(p || "").replace(/^data:[^,]*,/, "");
    let buf; try { buf = Buffer.from(raw, "base64"); } catch { buf = null; }
    const type = buf && sniff(buf);
    if (!type) return { status: 400, data: { error: "One of the pages isn't a photo I can read." } };
    if (buf.length > MAX_IMAGE_BYTES) return { status: 400, data: { error: "One of the photos is too big. Try again." } };
    bufs.push({ buf, type });
  }
  const id = nid();
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  bufs.forEach((p, i) => fs.writeFileSync(photoPath(id, i), p.buf));
  const note = { id, status: "reading", error: "", createdAt: Date.now(), savedAt: 0, photoTypes: bufs.map((p) => p.type), entry: null };
  notes().unshift(note);
  save();
  enqueue(id);
  return { status: 200, data: { ok: true, note: publicNote(note) } };
}

export function listNotes() {
  return { status: 200, data: { notes: notes().map(publicNote), types: SCAN_TYPES } };
}

export function getNote(id) {
  const n = findNote(id);
  return n ? { status: 200, data: { note: publicNote(n) } } : { status: 404, data: { error: "Note not found." } };
}

export function notePhoto(id, i) {
  const n = findNote(id);
  const idx = Number(i) | 0;
  if (!n || idx < 0 || idx >= n.photoTypes.length) return null;
  try { return { buf: fs.readFileSync(photoPath(n.id, idx)), type: n.photoTypes[idx] }; } catch { return null; }
}

export function retryNote(id) {
  const n = findNote(id);
  if (!n) return { status: 404, data: { error: "Note not found." } };
  if (n.status === "reading") return { status: 200, data: { ok: true, note: publicNote(n) } };
  n.status = "reading"; n.error = "";
  save();
  enqueue(n.id);
  return { status: 200, data: { ok: true, note: publicNote(n) } };
}

export function deleteNote(id) {
  const b = getBrain();
  const n = findNote(id);
  if (!n) return { status: 404, data: { error: "Note not found." } };
  n.photoTypes.forEach((_, i) => { try { fs.unlinkSync(photoPath(n.id, i)); } catch {} });
  b.notes = notes().filter((x) => x.id !== n.id);
  save();
  return { status: 200, data: { ok: true } };
}

export function setTodo(id, i, done) {
  const n = findNote(id);
  const t = n && n.entry && n.entry.todos[Number(i) | 0];
  if (!t) return { status: 404, data: { error: "To-do not found." } };
  t.done = !!done;
  save();
  return { status: 200, data: { ok: true, note: publicNote(n) } };
}

// Resolve a "needs a look" spot: confirm the guess, or replace it with the right word.
// A fix is remembered so the next scan reads that word right.
export function resolveUnclear(id, i, fix) {
  const n = findNote(id);
  const idx = Number(i) | 0;
  const u = n && n.entry && n.entry.unclear[idx];
  if (!u) return { status: 404, data: { error: "Nothing to check there." } };
  const value = str(fix, 200);
  if (value && value !== u.readAs) {
    const e = n.entry;
    const swap = (s) => (u.readAs && s.includes(u.readAs) ? s.split(u.readAs).join(value) : s);
    e.title = swap(e.title); e.summary = swap(e.summary);
    e.points = e.points.map(swap);
    e.todos.forEach((t) => { t.text = swap(t.text); t.who = swap(t.who); t.when = swap(t.when); });
    e.entities.forEach((x) => { x.name = swap(x.name); });
    const g = getBrain().scanGlossary;
    const written = str(u.written, 120);
    if (written) {
      const k = g.findIndex((x) => x.written.toLowerCase() === written.toLowerCase());
      if (k !== -1) g.splice(k, 1);
      g.unshift({ written, meaning: value });
      if (g.length > 200) g.length = 200;
    }
  }
  n.entry.unclear.splice(idx, 1);
  save();
  return { status: 200, data: { ok: true, note: publicNote(n) } };
}

function publicNote(n) {
  const b = getBrain();
  const titleOf = (id) => { const x = b.nodes.find((y) => y.id === id); return x ? x.title : null; };
  const e = n.entry;
  return {
    id: n.id, status: n.status, error: n.error, createdAt: n.createdAt, savedAt: n.savedAt,
    pages: n.photoTypes.length,
    entry: e ? { ...e, links: e.links.map((id) => ({ id, title: titleOf(id) })).filter((l) => l.title) } : null,
  };
}

// ---------- background reading ----------

function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  pump();
}
function pump() {
  while (running < 2 && queue.length) {
    const id = queue.shift();
    running++;
    readNote(id).finally(() => { running--; pump(); });
  }
}

async function readNote(id) {
  const n = findNote(id);
  if (!n || n.status !== "reading") return;
  try {
    if (!apiKey()) throw new Error("The scanner can't find an API key. Add ANTHROPIC_API_KEY to this service in Railway Variables, then tap Try again.");
    const images = n.photoTypes.map((type, i) => ({ type, data: fs.readFileSync(photoPath(n.id, i)).toString("base64") }));
    const raw = await callClaude(images);
    const cur = findNote(id);
    if (!cur) return; // deleted while reading
    cur.entry = cleanEntry(raw);
    cur.status = "saved";
    cur.error = "";
    cur.savedAt = Date.now();
  } catch (e) {
    const cur = findNote(id);
    if (!cur) return;
    cur.status = "failed";
    cur.error = String(e && e.message || "Couldn't read this one.").slice(0, 300);
    console.error("scanner:", cur.error);
  }
  save();
}

function systemPrompt() {
  const b = getBrain();
  const nodes = b.nodes.filter((x) => x.region !== "core")
    .map((x) => `- ${x.id}: ${x.title}${x.desc ? ". " + str(x.desc, 120) : ""}`).join("\n");
  const learned = b.scanGlossary.slice(0, 120).map((x) => `- "${x.written}" means "${x.meaning}"`).join("\n");
  const base = BASE_GLOSSARY.map(([a, c]) => `- ${a} = ${c}`).join("\n");
  const today = new Date().toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", timeZone: "America/New_York" });
  return `You read photos of Mathew Youhanna's handwritten notes and file each one into his Brain, his private store of notes and knowledge. Your job is to capture everything the page says, cleaned up and organized. Never rewrite it into something new, never add ideas that aren't on the page, never pad it.

About Mathew: independent life insurance broker (final expense and term) who runs a small agent team under Meridian Life Group, builds his own apps (Meridian OS card, QuoteDesk, Pulse, the Brain, Ingenium One), and studies for the NMLS SAFE MLO exam. His handwriting is fast and messy.

Reading rules:
- Crossed-out or scribbled-out writing is dropped. It goes nowhere in the entry.
- Where one word is written over another, the word on top (darker, later) is the one that counts.
- Arrows, carets, circled bits and margin notes belong with the line they point to.
- Expand shorthand only when the meaning is clear from the glossary or the page. Otherwise keep it as written.
- When a word is too rough to read, still put your best guess in the entry and list it under unclear. Never leave gaps, never make content up.
- Several photos are pages of one note. Combine them into one entry.
- Keep his wording where you can. Fix spelling, nothing else.

How to write the entry: plain, short, human. No em dashes. No filler like "This note discusses".
- type: one of ${SCAN_TYPES.join(", ")}. Pick what the page is: idea, meeting notes, a call, study notes, a plan, or a log of what happened.
- title: the page heading if there is one, otherwise a short name for what it's about.
- dateOnPage: a date written on the page, like "Nov 19" or "Nov 19, 2026". Empty if none. Today is ${today}.
- summary: one or two lines on what the page is about.
- points: every idea, fact and decision on the page, one line each. Don't repeat to-dos here.
- todos: anything that reads like a task. who and when only if written.
- entities: people, companies, carriers, places, phone numbers, emails, dollar amounts, dates.
- links: ids from the Brain list below that this page clearly touches. Only ids from the list.
- unclear: each spot you had to guess. written = how it looks on the page, readAs = the exact text you used in the entry.
- stats: lines of writing you found, crossed-out spots you dropped, written-over words you resolved.

Brain nodes you can link to:
${nodes || "(none yet)"}

Shorthand:
${base}
${learned ? "\nWords he has corrected before (trust these):\n" + learned : ""}`;
}

const ENTRY_TOOL = {
  name: "file_entry",
  description: "File the note into the Brain as one entry.",
  input_schema: {
    type: "object",
    properties: {
      type: { type: "string", enum: SCAN_TYPES },
      title: { type: "string" },
      dateOnPage: { type: "string" },
      summary: { type: "string" },
      points: { type: "array", items: { type: "string" } },
      todos: { type: "array", items: { type: "object", properties: { text: { type: "string" }, who: { type: "string" }, when: { type: "string" } }, required: ["text"] } },
      entities: { type: "array", items: { type: "object", properties: { name: { type: "string" }, kind: { type: "string", enum: ENTITY_KINDS } }, required: ["name", "kind"] } },
      links: { type: "array", items: { type: "string" } },
      unclear: { type: "array", items: { type: "object", properties: { written: { type: "string" }, readAs: { type: "string" } }, required: ["written", "readAs"] } },
      stats: { type: "object", properties: { lines: { type: "integer" }, crossedOut: { type: "integer" }, writtenOver: { type: "integer" } } },
    },
    required: ["type", "title", "summary", "points", "todos", "entities", "links", "unclear", "stats"],
  },
};

async function callClaude(images) {
  const body = {
    model: MODEL(),
    max_tokens: 4096,
    system: systemPrompt(),
    tools: [ENTRY_TOOL],
    tool_choice: { type: "tool", name: "file_entry" },
    messages: [{
      role: "user",
      content: [
        ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } })),
        { type: "text", text: `File this note. ${images.length} page${images.length > 1 ? "s" : ""}.` },
      ],
    }],
  };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 4000 * attempt));
    let res;
    try {
      res = await fetch(API_URL + "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey(), "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
    } catch (e) { lastErr = new Error("Couldn't reach the reader. Tap Try again."); continue; }
    if (res.status === 429 || res.status >= 500) { lastErr = new Error("The reader is busy right now. Tap Try again."); continue; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) throw new Error("The API key in Railway isn't working. Check it, then tap Try again.");
      throw new Error("Couldn't read this one: " + str(data && data.error && data.error.message, 200));
    }
    const tool = (data.content || []).find((c) => c.type === "tool_use" && c.name === "file_entry");
    if (!tool) throw new Error("Couldn't make sense of this page. Try a clearer photo.");
    return tool.input || {};
  }
  throw lastErr;
}

function cleanEntry(x) {
  const b = getBrain();
  const ids = new Set(b.nodes.filter((n) => n.region !== "core").map((n) => n.id));
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const noDash = (s) => s.replace(/\s*—\s*/g, ", ");
  const t = (v, n) => noDash(str(v, n));
  const int = (v) => Math.max(0, Math.min(999, Number(v) | 0));
  const stats = x.stats || {};
  return {
    type: SCAN_TYPES.includes(x.type) ? x.type : "log",
    title: t(x.title, 120) || "Untitled note",
    dateOnPage: t(x.dateOnPage, 40),
    summary: t(x.summary, 600),
    points: arr(x.points, 80).map((p) => t(p, 500)).filter(Boolean),
    todos: arr(x.todos, 40).map((d) => ({ text: t(d && d.text, 300), who: t(d && d.who, 80), when: t(d && d.when, 80), done: false })).filter((d) => d.text),
    entities: arr(x.entities, 60).map((e) => ({ name: t(e && e.name, 120), kind: ENTITY_KINDS.includes(e && e.kind) ? e.kind : "other" })).filter((e) => e.name),
    links: [...new Set(arr(x.links, 12).map((l) => String(l)).filter((l) => ids.has(l)))],
    unclear: arr(x.unclear, 30).map((u) => ({ written: t(u && u.written, 120), readAs: t(u && u.readAs, 200) })).filter((u) => u.readAs),
    stats: { lines: int(stats.lines), crossedOut: int(stats.crossedOut), writtenOver: int(stats.writtenOver) },
  };
}
