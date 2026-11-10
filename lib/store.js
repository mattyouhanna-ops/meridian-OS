// Simple durable JSON store: one file on disk, in-memory cache, atomic writes, write queue.
// Works locally and on a Railway Volume (set DATA_DIR to the mounted path, e.g. /data).
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "store.json");

const EMPTY = { owner: null, agents: {}, secret: null, meta: { createdAt: Date.now() } };

let cache = null;
let writing = Promise.resolve();

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

export function load() {
  if (cache) return cache;
  ensureDir();
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache.agents ||= {};
  } catch {
    cache = structuredClone(EMPTY);
  }
  return cache;
}

// Persist current cache atomically (temp file + rename). Serialized so writes never interleave.
export function save() {
  const snapshot = JSON.stringify(cache);
  writing = writing.then(() => new Promise((res) => {
    ensureDir();
    const tmp = FILE + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      fs.writeFileSync(tmp, snapshot);
      fs.renameSync(tmp, FILE);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      console.error("store save failed:", e.message);
    }
    res();
  }));
  return writing;
}

// Read-modify-write helper: mutate the store object, then persist.
export async function update(fn) {
  const db = load();
  const r = fn(db);
  await save();
  return r;
}

export function db() { return load(); }
