// Three-tier model for Meridian OS.
//   Developer (platform, you) → Agencies (co-branded tenants) → Agents (producers).
// The developer can manage every agency directly. An agency may also have its own owner login.
import crypto from "node:crypto";
import { db, save } from "./store.js";
import { normalizeProfile, normalizeSettings, hashPass, checkPass, slugify, DEFAULT_SETTINGS } from "./core.js";

const rid = (n = 6) => crypto.randomBytes(n).toString("hex");
const WORDS = ["Oak", "Pine", "Gold", "Ridge", "Harbor", "Vale", "Stone", "River", "North", "Summit", "Cedar", "Iron"];
const randWord = () => WORDS[crypto.randomInt(WORDS.length)];
const genPass = (p = "Meridian") => `${p}-${randWord()}-${crypto.randomInt(1000, 9999)}`;

// ---------------- Developer (platform super-admin) ----------------
export function getDeveloper() { return db().developer; }
export function ensureDeveloper() {
  const d = db();
  if (!d.developer) {
    d.developer = {
      email: (process.env.DEV_EMAIL || "mathewadvisement@gmail.com").toLowerCase(),
      passHash: hashPass(process.env.DEV_PASSWORD || "Meridian-Dev-Change-Me"),
      name: process.env.DEV_NAME || "Mathew Youhanna",
      platformBrand: process.env.PLATFORM_BRAND || "Meridian OS",
      createdAt: Date.now(),
      mustChange: !process.env.DEV_PASSWORD,
      alertEmails: [], alertSms: [],
    };
    save();
  }
  d.developer.alertEmails ||= [];
  d.developer.alertSms ||= [];
  // The Railway variables are the source of truth for the developer login.
  // Whenever DEV_PASSWORD / DEV_EMAIL are set, keep the stored developer in sync so the env value always works.
  if (process.env.DEV_PASSWORD && !checkPass(process.env.DEV_PASSWORD, d.developer.passHash)) {
    d.developer.passHash = hashPass(process.env.DEV_PASSWORD); d.developer.mustChange = false; save();
  }
  if (process.env.DEV_EMAIL && d.developer.email !== String(process.env.DEV_EMAIL).toLowerCase()) {
    d.developer.email = String(process.env.DEV_EMAIL).toLowerCase(); save();
  }
  d.agencies ||= {};
  ensureSeedAgency();
  return d.developer;
}
export function setDeveloperPass(next) { const d = db(); d.developer.passHash = hashPass(next); d.developer.mustChange = false; save(); }
export function setDevAlerts(emails, sms) {
  const d = db();
  d.developer.alertEmails = (emails || []).map(x => String(x).trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 20);
  d.developer.alertSms = (sms || []).map(x => String(x).trim()).filter(Boolean).slice(0, 20);
  save();
  return d.developer;
}
export function platformBrand() { return db().developer?.platformBrand || "Meridian OS"; }

// First agency = Meridian Life Group (the company Mathew is at). Seeded once.
function ensureSeedAgency() {
  const d = db();
  if (Object.keys(d.agencies).length) return;
  const id = rid();
  d.agencies[id] = {
    id, slug: "meridian", name: "Meridian Life Group",
    brand: { name: "Meridian Life Group", accent: "#d4af37", logo: null },
    active: true, createdAt: Date.now(),
    ownerEmail: null, ownerPassHash: null, ownerMustChange: false, // dev manages it directly until an owner is added
    corpLanding: process.env.CORP_LANDING_URL || null,
    compliance: "",
    alertEmails: [], alertSms: [], // extra people copied on every lead in this agency
  };
  save();
}

// ---------------- Agencies ----------------
export function listAgencies() { return Object.values(db().agencies).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }
export function getAgency(id) { return db().agencies[id] || null; }
export function getAgencyBySlug(slug) { return Object.values(db().agencies).find((a) => a.slug === slug) || null; }
export function getAgencyByOwnerEmail(email) {
  const e = String(email || "").toLowerCase();
  return Object.values(db().agencies).find((a) => a.ownerEmail === e) || null;
}
function uniqueAgencySlug(base) {
  const d = db(); let s = slugify(base), i = 2;
  while (Object.values(d.agencies).some((a) => a.slug === s)) { s = slugify(base) + "-" + i; i++; }
  return s;
}

export function createAgency(input = {}) {
  const d = db();
  const name = String(input.name || "").trim().slice(0, 80);
  if (!name) throw new Error("Agency name is required.");
  const id = rid();
  const slug = uniqueAgencySlug(input.slug || name);
  const ag = {
    id, slug, name,
    brand: { name, accent: String(input.accent || "#d4af37").slice(0, 9), logo: null },
    active: true, createdAt: Date.now(),
    ownerEmail: null, ownerPassHash: null, ownerMustChange: false,
    corpLanding: input.corpLanding || null, compliance: "",
    alertEmails: [], alertSms: [],
  };
  let ownerPassword = null;
  if (input.ownerEmail) {
    ownerPassword = input.ownerPassword || genPass("Owner");
    ag.ownerEmail = String(input.ownerEmail).toLowerCase().slice(0, 120);
    ag.ownerPassHash = hashPass(ownerPassword);
    ag.ownerMustChange = true;
  }
  d.agencies[id] = ag;
  save();
  return { agency: ag, ownerPassword };
}

export function updateAgency(id, patch = {}) {
  const d = db(); const a = d.agencies[id];
  if (!a) throw new Error("Agency not found.");
  if (typeof patch.name === "string" && patch.name.trim()) { a.name = patch.name.trim().slice(0, 80); a.brand.name = a.name; }
  if (typeof patch.accent === "string") a.brand.accent = patch.accent.slice(0, 9);
  if (typeof patch.active === "boolean") a.active = patch.active;
  if (typeof patch.corpLanding === "string") a.corpLanding = patch.corpLanding.slice(0, 300) || null;
  if (typeof patch.compliance === "string") a.compliance = patch.compliance.slice(0, 600);
  if (Array.isArray(patch.alertEmails)) a.alertEmails = patch.alertEmails.map(x => String(x).trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 20);
  if (Array.isArray(patch.alertSms)) a.alertSms = patch.alertSms.map(x => String(x).trim()).filter(Boolean).slice(0, 20);
  let ownerPassword = null;
  if (patch.ownerEmail !== undefined) {
    if (patch.ownerEmail) {
      a.ownerEmail = String(patch.ownerEmail).toLowerCase().slice(0, 120);
      if (!a.ownerPassHash || patch.resetOwner) { ownerPassword = patch.ownerPassword || genPass("Owner"); a.ownerPassHash = hashPass(ownerPassword); a.ownerMustChange = true; }
    } else { a.ownerEmail = null; a.ownerPassHash = null; }
  } else if (patch.resetOwner && a.ownerEmail) {
    ownerPassword = genPass("Owner"); a.ownerPassHash = hashPass(ownerPassword); a.ownerMustChange = true;
  }
  save();
  return { agency: a, ownerPassword };
}
export function setOwnerPass(agencyId, next) { const a = db().agencies[agencyId]; if (a) { a.ownerPassHash = hashPass(next); a.ownerMustChange = false; save(); } }

export function deleteAgency(id) {
  const d = db();
  if (!d.agencies[id]) return false;
  for (const [aid, ag] of Object.entries(d.agents)) if (ag.agencyId === id) delete d.agents[aid];
  delete d.agencies[id];
  save();
  return true;
}

// ---------------- Agents (belong to an agency) ----------------
export function listAgents(agencyId) {
  const all = Object.values(db().agents);
  const f = agencyId ? all.filter((a) => a.agencyId === agencyId) : all;
  return f.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
export function getAgent(id) { return db().agents[id] || null; }
export function getAgentBySlug(slug) { return Object.values(db().agents).find((a) => a.slug === slug) || null; }
export function getAgentByEmail(email) { const e = String(email || "").trim().toLowerCase(); if (!e) return null; return Object.values(db().agents).find((a) => (a.profile && String(a.profile.email || "").toLowerCase()) === e) || null; }
function uniqueSlug(base) {
  const d = db(); let s = slugify(base), i = 2;
  while (Object.values(d.agents).some((a) => a.slug === s)) { s = slugify(base) + "-" + i; i++; }
  return s;
}

export function createAgent(agencyId, input = {}) {
  const d = db();
  if (!d.agencies[agencyId]) throw new Error("Agency not found.");
  const profile = normalizeProfile({
    name: input.name, title: input.title, brand: d.agencies[agencyId].brand.name,
    phone: input.phone, email: input.email, npn: input.npn, states: input.states,
  });
  if (!profile.name) throw new Error("Agent name is required.");
  if (!profile.email) throw new Error("Agent email is required.");
  if (Object.values(d.agents).some((a) => a.profile.email === profile.email)) throw new Error("An agent with that email already exists.");
  const id = rid();
  const slug = uniqueSlug(input.slug || profile.name);
  const tempPassword = input.password || genPass();
  d.agents[id] = {
    id, slug, agencyId, active: true, createdAt: Date.now(),
    carrier: String(input.carrier || "").toLowerCase().slice(0, 20),
    profile, passHash: hashPass(tempPassword), mustChange: true,
    settings: structuredClone(DEFAULT_SETTINGS),
    links: {}, quotes: [], requests: [], visits: [], security: [], pushSubs: [],
    sessionsValidAfter: 0, cardVer: Date.now(),
  };
  save();
  return { agent: d.agents[id], tempPassword };
}

export function updateAgent(id, patch = {}) {
  const d = db(); const a = d.agents[id];
  if (!a) throw new Error("Agent not found.");
  if (patch.profile) { a.profile = normalizeProfile({ ...a.profile, ...patch.profile }); a.cardVer = Date.now(); }
  if (typeof patch.carrier === "string") a.carrier = patch.carrier.toLowerCase().slice(0, 20);
  if (typeof patch.active === "boolean") a.active = patch.active;
  if (patch.password) { a.passHash = hashPass(patch.password); a.mustChange = true; a.sessionsValidAfter = Date.now(); }
  if (patch.settings) a.settings = normalizeSettings({ ...a.settings, ...patch.settings });
  save();
  return a;
}
export function deleteAgent(id) { const d = db(); if (!d.agents[id]) return false; delete d.agents[id]; save(); return true; }

// ---------------- Summaries ----------------
export function agentSummary(a) {
  const newQuotes = a.quotes.filter((q) => q.status === "new").length;
  const newReq = a.requests.filter((r) => r.status === "pending").length;
  const views = Object.values(a.links).reduce((n, l) => n + (l.views || 0), 0);
  const sold = Object.values(a.links).reduce((n, l) => n + ((l.deals || []).filter((x) => x.type === "sold").length), 0);
  return { id: a.id, slug: a.slug, agencyId: a.agencyId, active: a.active, createdAt: a.createdAt,
    name: a.profile.name, title: a.profile.title, email: a.profile.email, phone: a.profile.phone, npn: a.profile.npn, states: a.profile.states, carrier: a.carrier || "",
    clients: Object.keys(a.links).length, newQuotes, newRequests: newReq, views, sold };
}

export function agencySummary(ag) {
  const agents = listAgents(ag.id).map(agentSummary);
  const t = agents.reduce((s, a) => ({ agents: s.agents + 1, newQuotes: s.newQuotes + a.newQuotes, newRequests: s.newRequests + a.newRequests, views: s.views + a.views, sold: s.sold + a.sold }), { agents: 0, newQuotes: 0, newRequests: 0, views: 0, sold: 0 });
  return { id: ag.id, slug: ag.slug, name: ag.name, brand: ag.brand, active: ag.active, createdAt: ag.createdAt,
    hasOwner: !!ag.ownerPassHash, ownerEmail: ag.ownerEmail, corpLanding: ag.corpLanding,
    alertEmails: ag.alertEmails || [], alertSms: ag.alertSms || [], totals: t };
}

// Agency that an agent belongs to (for co-branding + corp redirect)
export function agencyOf(agent) { return agent && db().agencies[agent.agencyId] || null; }
