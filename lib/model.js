// Multi-tenant model: one owner, many agents. Operates on the JSON store.
import crypto from "node:crypto";
import { db, save } from "./store.js";
import { normalizeProfile, normalizeSettings, hashPass, slugify, DEFAULT_SETTINGS } from "./core.js";

const rid = (n = 8) => crypto.randomBytes(n).toString("hex");

// ---------- Owner ----------
export function getOwner() { return db().owner; }

export function ensureOwner() {
  const d = db();
  if (d.owner) return d.owner;
  const email = (process.env.OWNER_EMAIL || "mathewadvisement@gmail.com").toLowerCase();
  const pass = process.env.OWNER_PASSWORD || "Meridian-Owner-Change-Me";
  d.owner = {
    email,
    passHash: hashPass(pass),
    name: process.env.OWNER_NAME || "Mathew Youhanna",
    brand: process.env.OWNER_BRAND || "Meridian Life Group",
    createdAt: Date.now(),
    mustChange: !process.env.OWNER_PASSWORD, // flag if using the default password
  };
  save();
  return d.owner;
}

export function setOwnerPass(nextPlain) {
  const d = db();
  d.owner.passHash = hashPass(nextPlain);
  d.owner.mustChange = false;
  save();
}

// ---------- Agents ----------
export function listAgents() {
  return Object.values(db().agents).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
export function getAgent(id) { return db().agents[id] || null; }
export function getAgentBySlug(slug) {
  return Object.values(db().agents).find((a) => a.slug === slug) || null;
}

function uniqueSlug(base) {
  const d = db();
  let s = slugify(base), i = 2;
  const taken = (x) => Object.values(d.agents).some((a) => a.slug === x);
  while (taken(s)) { s = slugify(base) + "-" + i; i++; }
  return s;
}

export function createAgent(input = {}) {
  const d = db();
  const profile = normalizeProfile({
    name: input.name, title: input.title, brand: input.brand || "Meridian Life Group",
    phone: input.phone, email: input.email, npn: input.npn, states: input.states,
  });
  if (!profile.name) throw new Error("Agent name is required.");
  if (!profile.email) throw new Error("Agent email is required.");
  if (Object.values(d.agents).some((a) => a.profile.email === profile.email)) {
    throw new Error("An agent with that email already exists.");
  }
  const id = rid(6);
  const slug = uniqueSlug(input.slug || profile.name);
  const tempPassword = input.password || ("Meridian-" + randomWord() + "-" + rid(2).toUpperCase());
  const agent = {
    id, slug, active: true, createdAt: Date.now(),
    profile,
    passHash: hashPass(tempPassword),
    mustChange: true,
    settings: structuredClone(DEFAULT_SETTINGS),
    links: {}, quotes: [], requests: [], visits: [], security: [],
    sessionsValidAfter: 0,
    cardVer: Date.now(),
  };
  d.agents[id] = agent;
  save();
  return { agent, tempPassword };
}

function randomWord() {
  const w = ["Oak", "Pine", "Gold", "Ridge", "Harbor", "Vale", "Stone", "River", "North", "Summit", "Cedar", "Iron"];
  return w[crypto.randomInt(w.length)];
}

export function updateAgent(id, patch = {}) {
  const d = db();
  const a = d.agents[id];
  if (!a) throw new Error("Agent not found.");
  if (patch.profile) {
    a.profile = normalizeProfile({ ...a.profile, ...patch.profile });
    a.cardVer = Date.now(); // bust the preview-image cache
  }
  if (typeof patch.active === "boolean") a.active = patch.active;
  if (patch.password) { a.passHash = hashPass(patch.password); a.mustChange = true; a.sessionsValidAfter = Date.now(); }
  if (patch.settings) a.settings = normalizeSettings({ ...a.settings, ...patch.settings });
  save();
  return a;
}

export function deleteAgent(id) {
  const d = db();
  if (!d.agents[id]) return false;
  delete d.agents[id];
  save();
  return true;
}

// Owner-facing summary row per agent
export function agentSummary(a) {
  const newQuotes = a.quotes.filter((q) => q.status === "new").length;
  const newReq = a.requests.filter((r) => r.status === "pending").length;
  const views = Object.values(a.links).reduce((n, l) => n + (l.views || 0), 0);
  const sold = Object.values(a.links).reduce((n, l) => n + ((l.deals || []).filter((x) => x.type === "sold").length), 0);
  return {
    id: a.id, slug: a.slug, active: a.active, createdAt: a.createdAt,
    name: a.profile.name, email: a.profile.email, phone: a.profile.phone,
    npn: a.profile.npn, states: a.profile.states,
    clients: Object.keys(a.links).length, newQuotes, newRequests: newReq, views, sold,
  };
}
