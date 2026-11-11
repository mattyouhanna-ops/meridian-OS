// Meridian Team platform — single Node server (built-ins + sharp only).
// Owner dashboard controls all agents; each agent has a card (/a/:slug) + dashboard (/a/:slug/admin).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { db, save } from "./lib/store.js";
import {
  normalizeProfile, normalizeSettings, FIELDS, DEFAULT_MESSAGE, cleanFields,
  hashPass, checkPass, makeSessionCookie, clearCookie, readSession, describeDevice, encField,
  DEFAULT_PRODUCTS, DEFAULT_PROMISES,
} from "./lib/core.js";
import { STATE_NAMES, statesFor } from "./lib/states.js";
import {
  ensureDeveloper, getDeveloper, setDeveloperPass, setDevAlerts, setDevCompliance, platformBrand,
  listAgencies, getAgency, getAgencyBySlug, getAgencyByOwnerEmail, createAgency, updateAgency, deleteAgency, setOwnerPass, agencySummary,
  agencyLicensed, licenseDaysLeft, setAgencyLicense,
  agentLocked, agentLoginFail, agentLoginOk, ownerLocked, ownerLoginFail, ownerLoginOk,
  agentDenied, denyAgent, reinstateAgent, requestReinstate,
  isPlatformFrozen, setPlatformFrozen,
  childAgencies, agencyScopeIds,
  listAgents, getAgent, getAgentBySlug, getAgentByEmail, createAgent, updateAgent, deleteAgent, agentSummary, agencyOf,
  listAccountRequests, addAccountRequest, setAccountRequestStatus,
} from "./lib/model.js";
import { cardPNG } from "./lib/og.js";
import { alertNewLead, sendEmail, welcomeEmailHTML } from "./lib/notify.js";
import { vapidPublicKey, addSubscription, pushToAgent } from "./lib/push.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(HERE, "public");
const PHOTOS = path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "photos");
try { fs.mkdirSync(PHOTOS, { recursive: true }); } catch {}
const PORT = process.env.PORT || 3000;
// Build id so installed (home-screen) apps can detect a new deploy and refresh.
const BUILD = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.BUILD_ID || String(Date.now());

ensureDeveloper(); // seed developer + Meridian (agency #1) on first boot

// ---------- small helpers ----------
const sendJSON = (res, status, data, headers = {}) =>
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(JSON.stringify(data));

// Locked-out response body. who = 'agent' | 'owner'.
function lockedBody(until, who) {
  const hrs = Math.max(1, Math.ceil((until - Date.now()) / 3600e3));
  const contact = who === "agent" ? "your agency owner or the Meridian OS admin" : "the Meridian OS admin";
  return { error: `Too many failed attempts — this account is locked for security. Try again in about ${hrs}h, or ask ${contact} to unlock you.`, locked: true, until };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
function who(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return { ip: xff || req.socket.remoteAddress || "unknown", place: "Unknown location", device: describeDevice(req.headers["user-agent"] || "") };
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function originOf(req) { const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0]; return `${proto}://${req.headers.host}`; }
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "there";

// Auto-send a welcome email to a new agent (no-op unless email is configured). Returns true if sent.
async function emailAgentWelcome(agent, tempPass, req) {
  const card = `${originOf(req)}/a/${agent.slug}`;
  const subject = `Your ${agent.profile.brand || "Meridian"} card is ready`;
  const text = `Hey ${firstName(agent.profile.name)} — your digital business card is ready.\n\n` +
    `1) Open ${card}/admin\n2) Sign in with: ${agent.profile.email} / ${tempPass}\n3) Set your own password, confirm your info, and you're live.\n\n` +
    `Your card to text out: ${card}\nTip: open it on your phone, Share → Add to Home Screen for the icon.\n\nPowered by ${platformBrand()}`;
  const html = welcomeEmailHTML({ name: agent.profile.name, signinUrl: `${card}/admin`, loginEmail: agent.profile.email, password: tempPass, cardUrl: card, origin: originOf(req) });
  return await sendEmail(agent.profile.email, subject, text, html);
}
async function emailOwnerWelcome(agency, email, pass, req) {
  const subject = `You're set up on ${platformBrand()} — ${agency.name}`;
  const text = `Your agency dashboard is ready.\n\n1) Open ${originOf(req)}/owner\n2) Sign in with: ${email} / ${pass}\n3) Change your password and add your agents.\n\nPowered by ${platformBrand()}`;
  const html = welcomeEmailHTML({ name: agency.name, signinUrl: `${originOf(req)}/owner`, loginEmail: email, password: pass, cardUrl: null, origin: originOf(req) });
  return await sendEmail(email, subject, text, html);
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".json": "application/json" };
function serveStatic(res, file, cache = "public, max-age=3600") {
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": cache }).end(buf);
  } catch { res.writeHead(404).end("Not found"); }
}
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const num = (v) => Math.min(1e9, Math.max(0, Math.round((Number(v) || 0) * 100) / 100));

function appendLog(list, entry, max) { list.unshift(entry); if (list.length > max) list.length = max; }

// ---------- session resolution ----------
function session(req) { return readSession(req.headers.cookie); }
function devSession(req) { const s = session(req); return s && s.r === "dev" ? s : null; }
// Owner session carries the agency id. Returns the agency, or null.
function ownerSession(req) { if (isPlatformFrozen()) return null; const s = session(req); if (!s || s.r !== "owner") return null; const ag = getAgency(s.id); return ag || null; }
function agentSession(req) {
  if (isPlatformFrozen()) return null;
  const s = session(req); if (!s || s.r !== "agent") return null;
  const a = getAgent(s.id); if (!a) return null;
  if (a.sessionsValidAfter && s.x - 12 * 3600e3 < a.sessionsValidAfter) return null;
  return a;
}

// ====================================================================
// PUBLIC CARD DATA  (/a/:slug/api/card)
// ====================================================================
async function handleCard(agent, url, req) {
  const P = normalizeProfile(agent.profile);
  const settings = normalizeSettings(agent.settings);
  const k = url.searchParams.get("k");
  const poll = url.searchParams.get("p") === "1";
  const w = who(req);
  const visit = { t: Date.now(), ...w, link: null, linkName: "Main link", view: settings.defaultAudience, flag: null };
  let fields, revoked = false, limited = false;

  if (!k && settings.mainLimited) { limited = true; visit.view = "limited"; visit.flag = "Main link is paused"; }
  else if (k) {
    const link = /^[A-Za-z0-9_-]{16,64}$/.test(k) ? agent.links[k] : null;
    const expired = link && link.expires && Date.now() > link.expires;
    visit.link = link ? k : "unknown";
    visit.linkName = link ? link.name : "Unknown / deleted link";
    if (!link || !link.active || expired) {
      revoked = true; visit.view = "blocked";
      visit.flag = !link ? "Tried a link that doesn't exist" : expired ? "Tried an expired link" : "Tried a link you turned off";
    } else {
      const paused = link.paused || link.audience === "limited";
      visit.view = paused ? "limited" : link.audience;
      if (paused) limited = true;
      else fields = link.audience === "custom" ? link.fields : settings.audiences[link.audience]?.fields;
      if (!poll) {
        const sig = w.ip + "|" + w.device;
        link.seen = link.seen || [];
        if (!link.seen.includes(sig)) { if (link.seen.length) visit.flag = "Opened from a new device or location"; link.seen = [sig, ...link.seen].slice(0, 20); }
        link.views = (link.views || 0) + 1; link.lastViewed = Date.now(); link.places = link.seen.length;
      }
    }
  }
  if (!poll) { appendLog(agent.visits, visit, 1000); save(); }

  const agc = agencyOf(agent);
  const compliance = [getDeveloper().compliance, agc && agc.compliance].filter(Boolean).join("\n\n");
  const base = { name: P.name, title: P.title, brand: P.brand, photo: agent.photoVer ? `/a/${agent.slug}/photo.jpg?v=${agent.photoVer}` : null, compliance };
  if (revoked) return { ...base, revoked: true, f: {} };
  if (limited) return { ...base, limited: true, f: {} };
  if (!fields) fields = settings.audiences[settings.defaultAudience]?.fields || {};
  const out = { ...base, f: { ...fields } };
  if (fields.phone) { out.phone = P.phone; out.phoneTel = P.phoneTel; }
  if (fields.email) out.email = P.email;
  if (fields.npn) out.npn = P.npn;
  if (!fields.npn) out.f.nipr = false;
  if (fields.states) out.states = statesFor(P.states, P.npn, P.name);
  if (fields.promise) out.promises = P.promises;
  if (fields.products) out.products = P.products;
  if (P.socials && P.socials.length) out.socials = P.socials;
  return out;
}

async function handleQuote(agent, body, req) {
  const w = who(req);
  const kind = body.kind === "appointment" ? "appointment" : "quote";
  const entry = {
    id: crypto.randomBytes(8).toString("hex"), t: Date.now(), kind, status: "new",
    product: str(body.product, 80), name: str(body.name, 80),
    phone: str(body.phone || body.contact, 40), email: str(body.email, 120),
    coverage: str(body.coverage, 60), budget: str(body.budget, 60),
    when: str(body.when, 40), slot: str(body.slot, 30), method: str(body.method, 30),
    note: str(body.note, 400),
  };
  const k = str(body.k, 64);
  let linkName = "Main link", validK = null;
  if (k && /^[A-Za-z0-9_-]{16,64}$/.test(k) && agent.links[k]) { linkName = agent.links[k].name; validK = k; }
  else if (k) linkName = "Unknown link";
  entry.k = validK; entry.linkName = linkName; Object.assign(entry, w);
  appendLog(agent.quotes, entry, 300);
  const label = kind === "appointment" ? `Appointment request${entry.when ? " for " + entry.when : ""}` : `Quote request: ${entry.product || "general"}`;
  appendLog(agent.security, { t: Date.now(), ...w, event: `${label}${entry.name ? " — " + entry.name : ""}` }, 300);
  save();
  const ag = agencyOf(agent);
  const dev = getDeveloper();
  const emails = [...new Set([...(ag?.alertEmails || []), ...(dev.alertEmails || [])])];
  const sms = [...new Set([...(ag?.alertSms || []), ...(dev.alertSms || [])])];
  alertNewLead(agent, entry, { emails, sms }, originOf(req)); // fire-and-forget; branded HTML + dashboard link
  // Free app-like push notification to the agent's phone
  const who2 = entry.name ? " from " + entry.name : "";
  const bits2 = [entry.product, entry.coverage, entry.budget].filter(Boolean).join(" · ");
  pushToAgent(agent, {
    title: entry.kind === "appointment" ? "New appointment" + who2 : "New quote" + who2,
    body: bits2 || "Tap to view and respond.",
    url: `${originOf(req)}/a/${agent.slug}/admin`,
    tag: "lead",
  }).catch(() => {});
  return { ok: true };
}

async function handleRequestAccess(agent, body, req) {
  const w = who(req);
  const name = str(body.name, 80), k = str(body.k, 64);
  let linkName = "Main link", validK = null;
  if (k && /^[A-Za-z0-9_-]{16,64}$/.test(k) && agent.links[k]) { linkName = agent.links[k].name; validK = k; }
  else if (k) linkName = "Unknown link";
  appendLog(agent.requests, { id: crypto.randomBytes(8).toString("hex"), t: Date.now(), name, linkName, k: validK, status: "pending", ...w }, 300);
  save();
  return { ok: true };
}

// ====================================================================
// AGENT AUTH  (/a/:slug/api/auth/*)  — accounts are provisioned by the owner
// ====================================================================
const loginLocks = new Map();
async function handleAgentAuth(agent, action, method, body, req) {
  if (action === "status" && method === "GET") return { status: 200, data: { setup: true, inviteRequired: false, mustChange: !!agent.mustChange } };
  if (action === "me" && method === "GET") { const a = agentSession(req); return a && a.id === agent.id ? { status: 200, data: { ok: true, email: a.profile.email } } : { status: 401, data: { ok: false } }; }
  if (method !== "POST" || !sameOrigin(req)) return { status: 403, data: { error: "Not allowed" } };
  if (action === "logout") return { status: 200, data: { ok: true }, cookie: clearCookie };
  if (action === "invite") return { status: 200, data: { ok: true } }; // not used in team mode
  if (action === "setup") return { status: 409, data: { error: "Your account is managed by your team owner. Use Sign in." } };
  if (action === "forgot") return { status: 400, data: { error: "Ask your team owner to reset your password." } };

  if (action === "login") {
    const w = who(req);
    if (agentDenied(agent)) return { status: 403, data: { error: "Your access has been revoked. You can request to have it restored.", denied: true, slug: agent.slug } };
    const until0 = agentLocked(agent);
    if (until0) return { status: 423, data: lockedBody(until0, "agent") };
    const email = String(body.email || "").trim().toLowerCase();
    const pass = String(body.passcode || "");
    await new Promise((r) => setTimeout(r, 300));
    if (email === agent.profile.email && checkPass(pass, agent.passHash)) {
      agentLoginOk(agent.id);
      appendLog(agent.security, { t: Date.now(), ...w, event: "Signed in (" + email + ")" }, 300); save();
      return { status: 200, data: { ok: true, mustChange: !!agent.mustChange }, cookie: makeSessionCookie("agent", agent.id) };
    }
    const lu = agentLoginFail(agent.id);
    appendLog(agent.security, { t: Date.now(), ...w, event: "Wrong passcode" }, 300); save();
    return lu ? { status: 423, data: lockedBody(lu, "agent") } : { status: 401, data: { error: "Email or passcode is incorrect." } };
  }
  return { status: 404, data: { error: "Not found" } };
}

// ====================================================================
// AGENT ADMIN  (/a/:slug/api/admin/*)  — the agent's own dashboard
// ====================================================================
const STATUSES = ["new", "chat", "quoted", "sold"];
function cleanDeals(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 60).map((d) => ({
    id: str(d.id, 24) || crypto.randomBytes(6).toString("hex"),
    type: d.type === "sold" ? "sold" : "quoted",
    product: str(d.product, 80), carrier: str(d.carrier, 80),
    face: num(d.face), premium: num(d.premium), freq: d.freq === "year" ? "year" : "month",
    note: str(d.note, 300), date: Number(d.date) || Date.now(),
  }));
}
async function handleAdmin(agent, sub, method, body, req) {
  const w = who(req);
  const S = () => normalizeSettings(agent.settings);

  if (sub === "state" && method === "GET")
    return { status: 200, data: { email: agent.profile.email, fields: FIELDS, stateNames: STATE_NAMES, profile: normalizeProfile(agent.profile), settings: S(), links: agent.links, mustChange: !!agent.mustChange, photo: agent.photoVer ? `/a/${agent.slug}/photo.jpg?v=${agent.photoVer}` : null, catalog: { products: DEFAULT_PRODUCTS, promises: DEFAULT_PROMISES } } };

  if (sub === "profile" && method === "POST") {
    const next = normalizeProfile({ ...agent.profile, ...(body.profile || {}) });
    if (!next.name || !next.email || !next.phone) return { status: 400, data: { error: "Name, phone and email can't be blank." } };
    agent.profile = next; agent.cardVer = Date.now();
    appendLog(agent.security, { t: Date.now(), ...w, event: "Edited card details" }, 300); save();
    return { status: 200, data: { ok: true, profile: next } };
  }

  if (sub === "preview" && method === "POST") {
    const P = normalizeProfile(body.profile || {}); const fields = cleanFields(body.fields);
    const out = { name: P.name, title: P.title, brand: P.brand, f: { ...fields } };
    if (fields.phone) { out.phone = P.phone; out.phoneTel = P.phoneTel; }
    if (fields.email) out.email = P.email;
    if (fields.npn) out.npn = P.npn;
    if (!fields.npn) out.f.nipr = false;
    if (fields.states) out.states = statesFor(P.states, P.npn, P.name);
    if (fields.promise) out.promises = P.promises;
    if (fields.products) out.products = P.products;
    return { status: 200, data: out };
  }

  if (sub === "requests" && method === "GET") return { status: 200, data: { requests: agent.requests } };
  if (sub === "requests/clear" && method === "POST") { agent.requests = []; save(); return { status: 200, data: { ok: true } }; }
  if (sub === "requests/resolve" && method === "POST") {
    const r = agent.requests.find((x) => x.id === body.id);
    if (!r) return { status: 404, data: { error: "Request not found." } };
    const approve = body.action === "approve";
    r.status = approve ? "approved" : "denied"; r.resolvedAt = Date.now();
    if (approve && r.k && agent.links[r.k]) { agent.links[r.k].paused = false; appendLog(agent.security, { t: Date.now(), ...w, event: `Approved access for ${r.name || r.linkName}` }, 300); }
    else if (!approve) appendLog(agent.security, { t: Date.now(), ...w, event: `Denied access for ${r.name || r.linkName}` }, 300);
    save();
    return { status: 200, data: { ok: true, requests: agent.requests, links: agent.links } };
  }

  if (sub === "quotes" && method === "GET") return { status: 200, data: { quotes: agent.quotes } };
  if (sub === "quotes/clear" && method === "POST") { agent.quotes = []; save(); return { status: 200, data: { ok: true } }; }
  if (sub === "quotes/resolve" && method === "POST") {
    const q = agent.quotes.find((x) => x.id === body.id);
    if (q) { q.status = "done"; q.resolvedAt = Date.now(); save(); }
    return { status: 200, data: { ok: true, quotes: agent.quotes } };
  }

  if (sub === "activity" && method === "GET") return { status: 200, data: { visits: agent.visits.slice(0, 500), security: agent.security.slice(0, 200) } };
  if (sub === "activity/clear" && method === "POST") { agent.visits = []; save(); return { status: 200, data: { ok: true } }; }
  if (sub === "security/clear" && method === "POST") { agent.security = []; save(); return { status: 200, data: { ok: true } }; }

  if (sub === "settings" && method === "POST") {
    const s = S();
    for (const a of Object.keys(s.audiences)) if (body.audiences?.[a]) s.audiences[a].fields = cleanFields(body.audiences[a].fields);
    if (body.defaultAudience in s.audiences) s.defaultAudience = body.defaultAudience;
    if (typeof body.sendMessage === "string") s.sendMessage = body.sendMessage.trim().slice(0, 600) || DEFAULT_MESSAGE;
    if (typeof body.mainLimited === "boolean") { if (body.mainLimited !== s.mainLimited) appendLog(agent.security, { t: Date.now(), ...w, event: body.mainLimited ? "Paused the MAIN link" : "Restored the MAIN link" }, 300); s.mainLimited = body.mainLimited; }
    agent.settings = s; save();
    return { status: 200, data: { ok: true, settings: s } };
  }

  if (sub === "links" && method === "POST") {
    const name = str(body.name, 80);
    if (!name) return { status: 400, data: { error: "Enter who this link is for." } };
    const audience = ["prospect", "client", "custom"].includes(body.audience) ? body.audience : "client";
    const token = crypto.randomBytes(18).toString("base64url");
    agent.links[token] = {
      name, audience, fields: audience === "custom" ? cleanFields(body.fields) : null,
      active: true, paused: false, created: Date.now(), expires: null, views: 0, lastViewed: null, places: 0, seen: [],
      status: "new", statusAt: Date.now(), phone: str(body.phone, 40), notes: str(body.notes, 1000), deals: [],
      manual: !!body.manual,
      fromVisit: body.fromVisit ? { sig: str(body.fromVisit.sig, 200), place: str(body.fromVisit.place, 80), device: str(body.fromVisit.device, 80), t: Number(body.fromVisit.t) || null } : null,
    };
    save();
    return { status: 200, data: { ok: true, token, links: agent.links } };
  }

  const m = sub.match(/^links\/([A-Za-z0-9_-]{16,64})$/);
  if (m) {
    const l = agent.links[m[1]];
    if (!l) return { status: 404, data: { error: "Link not found." } };
    if (method === "DELETE") { delete agent.links[m[1]]; save(); return { status: 200, data: { ok: true, links: agent.links } }; }
    if (method === "PATCH") {
      if (typeof body.active === "boolean") l.active = body.active;
      const beforePaused = l.paused || l.audience === "limited";
      if (l.audience === "limited") l.audience = "client";
      if (["prospect", "client", "custom"].includes(body.audience)) l.audience = body.audience;
      if (body.fields) l.fields = cleanFields(body.fields);
      if (typeof body.name === "string" && body.name.trim()) l.name = body.name.trim().slice(0, 80);
      if (typeof body.paused === "boolean") l.paused = body.paused;
      if (body.resetPlaces) { l.seen = []; l.places = 0; }
      if (STATUSES.includes(body.status) && body.status !== l.status) { l.status = body.status; l.statusAt = Date.now(); }
      if (typeof body.phone === "string") l.phone = str(body.phone, 40);
      if (typeof body.notes === "string") l.notes = str(body.notes, 1000);
      if (Array.isArray(body.deals)) l.deals = cleanDeals(body.deals);
      const afterPaused = !!l.paused;
      if (afterPaused !== beforePaused) appendLog(agent.security, { t: Date.now(), ...w, event: (afterPaused ? "Paused" : "Gave access back to") + ` ${l.name}` }, 300);
      save();
      return { status: 200, data: { ok: true, links: agent.links } };
    }
  }

  if (sub === "passcode" && method === "POST") {
    if (!checkPass(String(body.current || ""), agent.passHash)) return { status: 401, data: { error: "Current passcode is incorrect." } };
    const next = String(body.next || "");
    if (next.length < 6) return { status: 400, data: { error: "New passcode must be at least 6 characters." } };
    agent.passHash = hashPass(next); agent.mustChange = false; agent.sessionsValidAfter = Date.now(); agent.issuedPass = null; agent.curPass = encField(next);
    appendLog(agent.security, { t: Date.now(), ...w, event: "Passcode changed" }, 300); save();
    return { status: 200, data: { ok: true } };
  }
  // First-login: set the initial password. Allowed only while mustChange is true (session already authenticated).
  if (sub === "firstpass" && method === "POST") {
    if (!agent.mustChange) return { status: 409, data: { error: "Password already set." } };
    const next = String(body.next || "");
    if (next.length < 6) return { status: 400, data: { error: "Password must be at least 6 characters." } };
    agent.passHash = hashPass(next); agent.mustChange = false; agent.issuedPass = null; agent.curPass = encField(next);
    appendLog(agent.security, { t: Date.now(), ...w, event: "Set password (onboarding)" }, 300); save();
    return { status: 200, data: { ok: true } };
  }
  if (sub === "onboarded" && method === "POST") { agent.mustChange = false; save(); return { status: 200, data: { ok: true } }; }
  if (sub === "push-subscribe" && method === "POST") { addSubscription(agent, body.subscription); return { status: 200, data: { ok: true } }; }
  if (sub === "photo" && method === "POST") {
    try {
      const m = String(body.image || "").match(/^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/);
      if (!m) return { status: 400, data: { error: "Please choose a JPG or PNG image." } };
      const raw = Buffer.from(m[1], "base64");
      if (raw.length > 12 * 1024 * 1024) return { status: 400, data: { error: "That image is too large (max ~12MB)." } };
      const sharp = (await import("sharp")).default;
      const out = await sharp(raw).rotate().resize(480, 480, { fit: "cover" }).jpeg({ quality: 82 }).toBuffer();
      fs.writeFileSync(path.join(PHOTOS, agent.id + ".jpg"), out);
      agent.photoVer = Date.now(); agent.cardVer = Date.now();
      appendLog(agent.security, { t: Date.now(), ...w, event: "Updated profile photo" }, 300); save();
      return { status: 200, data: { ok: true, photo: `/a/${agent.slug}/photo.jpg?v=${agent.photoVer}` } };
    } catch (e) { return { status: 400, data: { error: "Couldn't process that image. Try another." } }; }
  }
  if (sub === "photo/remove" && method === "POST") {
    try { fs.unlinkSync(path.join(PHOTOS, agent.id + ".jpg")); } catch {}
    agent.photoVer = 0; agent.cardVer = Date.now(); save();
    return { status: 200, data: { ok: true } };
  }
  if (sub === "signout-all" && method === "POST") { agent.sessionsValidAfter = Date.now(); save(); return { status: 200, data: { ok: true } }; }

  return { status: 404, data: { error: "Not found" } };
}

// shared: build an agent patch from a request body
function agentPatch(body) {
  const patch = {};
  if (body.profile) patch.profile = body.profile;
  if (typeof body.carrier === "string") patch.carrier = body.carrier;
  if (typeof body.active === "boolean") patch.active = body.active;
  if (body.password) patch.password = String(body.password);
  if (body.unlock) patch.unlock = true;
  return patch;
}
function agencyLeads(agencyId) {
  const leads = [];
  for (const id of agencyScopeIds(agencyId)) for (const a of listAgents(id)) for (const q of a.quotes) leads.push({ ...q, agent: a.profile.name, agentSlug: a.slug, agentId: a.id });
  leads.sort((x, y) => y.t - x.t);
  return leads.slice(0, 500);
}

// ====================================================================
// OWNER API  (/api/owner/*)  — scoped to the owner's own agency
// ====================================================================
const ownerLock = new Map();
async function handleOwner(sub, method, body, req) {
  if (sub === "me" && method === "GET") { const ag = ownerSession(req); return ag ? { status: 200, data: { ok: true, email: ag.ownerEmail, agency: ag.name, brand: ag.brand, mustChange: !!ag.ownerMustChange, licensed: agencyLicensed(ag), daysLeft: licenseDaysLeft(ag) } } : { status: 401, data: { ok: false } }; }
  if (method !== "GET" && !sameOrigin(req)) return { status: 403, data: { error: "Not allowed" } };

  if (sub === "login" && method === "POST") {
    const email = String(body.email || "").trim().toLowerCase();
    await new Promise((r) => setTimeout(r, 300));
    const ag = getAgencyByOwnerEmail(email);
    if (ag && ag.ownerPassHash) {
      const until0 = ownerLocked(ag);
      if (until0) return { status: 423, data: lockedBody(until0, "owner") };
      if (checkPass(String(body.passcode || ""), ag.ownerPassHash)) {
        ownerLoginOk(ag.id);
        return { status: 200, data: { ok: true, mustChange: !!ag.ownerMustChange }, cookie: makeSessionCookie("owner", ag.id) };
      }
      const lu = ownerLoginFail(ag.id);
      return lu ? { status: 423, data: lockedBody(lu, "owner") } : { status: 401, data: { error: "Email or password is incorrect." } };
    }
    return { status: 401, data: { error: "Email or password is incorrect." } };
  }
  if (sub === "logout" && method === "POST") return { status: 200, data: { ok: true }, cookie: clearCookie };

  const ag = ownerSession(req);
  if (!ag) return { status: 401, data: { error: "Please sign in." } };

  // Parent owners see everything beneath them (one level: their agency + its child agencies).
  const scope = agencyScopeIds(ag.id);
  const inScope = (a) => a && scope.includes(a.agencyId);

  const licensed = agencyLicensed(ag);
  const license = { licensed, daysLeft: licenseDaysLeft(ag), licenseUntil: ag.licenseUntil || null, platform: platformBrand() };
  // When the lease has lapsed, the owner can sign in and look, but can't make
  // changes until the developer renews it — forces them back to the developer.
  const needsRenewal = () => ({ status: 403, data: { error: `Your ${platformBrand()} license needs to be renewed. Contact your platform administrator to continue.`, locked: true, license } });
  // Lock the owner's management actions (adding, editing, removing agents) when the lease has lapsed.
  if (!licensed && ((sub === "agents" && method === "POST") || (/^agents\/[a-z0-9]+$/i.test(sub) && method !== "GET"))) return needsRenewal();

  if (sub === "data" && method === "GET") {
    const children = childAgencies(ag.id);
    const agents = scope.flatMap((id) => listAgents(id)).map((a) => { const s = agentSummary(a); if (a.agencyId !== ag.id) { const c = getAgency(a.agencyId); s.subAgency = c ? c.name : ""; } return s; });
    const totals = agents.reduce((t, a) => ({ agents: t.agents + 1, newQuotes: t.newQuotes + a.newQuotes, newRequests: t.newRequests + a.newRequests, views: t.views + a.views, sold: t.sold + a.sold }), { agents: 0, newQuotes: 0, newRequests: 0, views: 0, sold: 0 });
    return { status: 200, data: { owner: { email: ag.ownerEmail, agency: ag.name, brand: ag.brand, mustChange: !!ag.ownerMustChange }, agents, totals, subAgencies: children.map((c) => ({ id: c.id, name: c.name })), stateNames: STATE_NAMES, platformBrand: platformBrand(), license } };
  }
  if (sub === "agents" && method === "POST") {
    try { const { agent, tempPassword } = createAgent(ag.id, body); const emailed = await emailAgentWelcome(agent, tempPassword, req); return { status: 200, data: { ok: true, agent: agentSummary(agent), slug: agent.slug, tempPassword, emailed } }; }
    catch (e) { return { status: 400, data: { error: e.message } }; }
  }
  const am = sub.match(/^agents\/([a-z0-9]+)$/i);
  if (am) {
    const a = getAgent(am[1]);
    if (!inScope(a)) return { status: 404, data: { error: "Agent not found." } };
    if (method === "PATCH") { try { const u = updateAgent(a.id, agentPatch(body)); return { status: 200, data: { ok: true, agent: agentSummary(u) } }; } catch (e) { return { status: 400, data: { error: e.message } }; } }
    if (method === "DELETE") { deleteAgent(a.id); return { status: 200, data: { ok: true } }; }
  }
  const dm = sub.match(/^agent\/([a-z0-9]+)\/detail$/i);
  if (dm && method === "GET") {
    const a = getAgent(dm[1]); if (!inScope(a)) return { status: 404, data: { error: "Agent not found." } };
    return { status: 200, data: { profile: normalizeProfile(a.profile), slug: a.slug, active: a.active, links: a.links, quotes: a.quotes, requests: a.requests, visits: a.visits.slice(0, 200), security: a.security.slice(0, 100) } };
  }
  if (sub === "leads" && method === "GET") return { status: 200, data: { leads: agencyLeads(ag.id) } };
  if (sub === "passcode" && method === "POST") {
    if (!checkPass(String(body.current || ""), ag.ownerPassHash)) return { status: 401, data: { error: "Current password is incorrect." } };
    if (String(body.next || "").length < 8) return { status: 400, data: { error: "New password must be at least 8 characters." } };
    setOwnerPass(ag.id, String(body.next)); return { status: 200, data: { ok: true } };
  }
  return { status: 404, data: { error: "Not found" } };
}

// ====================================================================
// DEVELOPER API  (/api/dev/*)  — platform control over all agencies
// ====================================================================
const devLock = { n: 0, t: Date.now() };
async function handleDev(sub, method, body, req) {
  const dev = getDeveloper();
  if (sub === "me" && method === "GET") { return devSession(req) ? { status: 200, data: { ok: true, email: dev.email, name: dev.name, brand: dev.platformBrand, mustChange: !!dev.mustChange } } : { status: 401, data: { ok: false } }; }
  if (method !== "GET" && !sameOrigin(req)) return { status: 403, data: { error: "Not allowed" } };

  if (sub === "login" && method === "POST") {
    if (Date.now() - devLock.t > 15 * 60e3) { devLock.n = 0; devLock.t = Date.now(); }
    if (devLock.n >= 8) return { status: 429, data: { error: "Too many attempts. Try again later." } };
    await new Promise((r) => setTimeout(r, 300));
    if (String(body.email || "").trim().toLowerCase() === dev.email && checkPass(String(body.passcode || ""), dev.passHash)) {
      devLock.n = 0; return { status: 200, data: { ok: true, mustChange: !!dev.mustChange }, cookie: makeSessionCookie("dev", "dev") };
    }
    devLock.n++; return { status: 401, data: { error: "Email or password is incorrect." } };
  }
  if (sub === "logout" && method === "POST") return { status: 200, data: { ok: true }, cookie: clearCookie };

  if (!devSession(req)) return { status: 401, data: { error: "Please sign in." } };

  if (sub === "data" && method === "GET") {
    const agencies = listAgencies().map(agencySummary);
    const totals = agencies.reduce((t, a) => ({ agencies: t.agencies + 1, agents: t.agents + a.totals.agents, newQuotes: t.newQuotes + a.totals.newQuotes, views: t.views + a.totals.views, sold: t.sold + a.totals.sold }), { agencies: 0, agents: 0, newQuotes: 0, views: 0, sold: 0 });
    return { status: 200, data: { dev: { email: dev.email, name: dev.name, brand: dev.platformBrand, mustChange: !!dev.mustChange, alertEmails: dev.alertEmails || [], alertSms: dev.alertSms || [], compliance: dev.compliance || "" }, agencies, totals, stateNames: STATE_NAMES, frozen: isPlatformFrozen() } };
  }
  if (sub === "alerts" && method === "POST") { const d = setDevAlerts(body.alertEmails, body.alertSms); return { status: 200, data: { ok: true, alertEmails: d.alertEmails, alertSms: d.alertSms } }; }
  if (sub === "freeze" && method === "POST") { const on = setPlatformFrozen(!!body.on); return { status: 200, data: { ok: true, frozen: on } }; }
  if (sub === "compliance" && method === "POST") { const c = setDevCompliance(body.text); return { status: 200, data: { ok: true, compliance: c } }; }
  // Per-agency + per-agent analytics for the Metrics tab
  if (sub === "metrics" && method === "GET") {
    const agencies = listAgencies().map((ag) => {
      const agents = listAgents(ag.id).map(agentSummary);
      const t = agents.reduce((s, a) => ({ agents: s.agents + 1, views: s.views + a.views, clicks: s.clicks + a.totalViews, unique: s.unique + a.unique, newQuotes: s.newQuotes + a.newQuotes, quotes: s.quotes + a.totalQuotes, sold: s.sold + a.sold, clients: s.clients + a.clients, producing: s.producing + (a.sold > 0 ? 1 : 0), engaged: s.engaged + (a.totalViews > 0 ? 1 : 0), active: s.active + ((a.active && !a.denied) ? 1 : 0) }), { agents: 0, views: 0, clicks: 0, unique: 0, newQuotes: 0, quotes: 0, sold: 0, clients: 0, producing: 0, engaged: 0, active: 0 });
      t.activeRatio = t.agents ? Math.round((t.engaged / t.agents) * 100) : 0;       // % of cards actually opened
      t.conversion = t.clicks ? Math.round((t.quotes / t.clicks) * 100) : 0;          // clicks that became a lead
      return { id: ag.id, name: ag.name, active: ag.active, licensed: agencyLicensed(ag), totals: t, agents };
    });
    const platform = agencies.reduce((s, a) => ({ agencies: s.agencies + 1, agents: s.agents + a.totals.agents, views: s.views + a.totals.views, clicks: s.clicks + a.totals.clicks, unique: s.unique + a.totals.unique, newQuotes: s.newQuotes + a.totals.newQuotes, quotes: s.quotes + a.totals.quotes, sold: s.sold + a.totals.sold, producing: s.producing + a.totals.producing, engaged: s.engaged + a.totals.engaged }), { agencies: 0, agents: 0, views: 0, clicks: 0, unique: 0, newQuotes: 0, quotes: 0, sold: 0, producing: 0, engaged: 0 });
    platform.activeRatio = platform.agents ? Math.round((platform.engaged / platform.agents) * 100) : 0;
    platform.conversion = platform.clicks ? Math.round((platform.quotes / platform.clicks) * 100) : 0;
    return { status: 200, data: { platform, agencies } };
  }
  if (sub === "agencies" && method === "POST") {
    try { const { agency, ownerPassword } = createAgency(body); let emailed = false; if (ownerPassword && agency.ownerEmail) emailed = await emailOwnerWelcome(agency, agency.ownerEmail, ownerPassword, req); return { status: 200, data: { ok: true, agency: agencySummary(agency), ownerPassword, emailed } }; }
    catch (e) { return { status: 400, data: { error: e.message } }; }
  }
  const gm = sub.match(/^agencies\/([a-z0-9]+)$/i);
  if (gm) {
    if (!getAgency(gm[1])) return { status: 404, data: { error: "Agency not found." } };
    if (method === "PATCH") { try { const { agency, ownerPassword } = updateAgency(gm[1], body); let emailed = false; if (ownerPassword && agency.ownerEmail) emailed = await emailOwnerWelcome(agency, agency.ownerEmail, ownerPassword, req); return { status: 200, data: { ok: true, agency: agencySummary(agency), ownerPassword, emailed } }; } catch (e) { return { status: 400, data: { error: e.message } }; } }
    if (method === "DELETE") { deleteAgency(gm[1]); return { status: 200, data: { ok: true } }; }
  }
  // agents within a specific agency
  const al = sub.match(/^agencies\/([a-z0-9]+)\/agents$/i);
  if (al) {
    if (!getAgency(al[1])) return { status: 404, data: { error: "Agency not found." } };
    if (method === "GET") return { status: 200, data: { agents: listAgents(al[1]).map(agentSummary) } };
    if (method === "POST") { try { const { agent, tempPassword } = createAgent(al[1], body); const emailed = await emailAgentWelcome(agent, tempPassword, req); return { status: 200, data: { ok: true, agent: agentSummary(agent), slug: agent.slug, tempPassword, emailed } }; } catch (e) { return { status: 400, data: { error: e.message } }; } }
  }
  const am2 = sub.match(/^agents\/([a-z0-9]+)$/i);
  if (am2) {
    if (!getAgent(am2[1])) return { status: 404, data: { error: "Agent not found." } };
    if (method === "PATCH") { try { const u = updateAgent(am2[1], agentPatch(body)); return { status: 200, data: { ok: true, agent: agentSummary(u) } }; } catch (e) { return { status: 400, data: { error: e.message } }; } }
    if (method === "DELETE") { deleteAgent(am2[1]); return { status: 200, data: { ok: true } }; }
  }
  // developer-only: deny (revoke) an agent for fraud, or reinstate them
  const dnm = sub.match(/^agents\/([a-z0-9]+)\/(deny|reinstate)$/i);
  if (dnm && method === "POST") {
    if (!getAgent(dnm[1])) return { status: 404, data: { error: "Agent not found." } };
    const a = dnm[2] === "deny" ? denyAgent(dnm[1], body.reason) : reinstateAgent(dnm[1]);
    return { status: 200, data: { ok: true, agent: agentSummary(a) } };
  }
  // developer renews / extends / clears an agency's license lease
  const lm = sub.match(/^agencies\/([a-z0-9]+)\/license$/i);
  if (lm && method === "POST") {
    if (!getAgency(lm[1])) return { status: 404, data: { error: "Agency not found." } };
    try { const a = setAgencyLicense(lm[1], { days: Number(body.days) || 0, until: Number(body.until) || 0, clear: !!body.clear }); return { status: 200, data: { ok: true, agency: agencySummary(a) } }; }
    catch (e) { return { status: 400, data: { error: e.message } }; }
  }
  // account requests (public "request an account" submissions)
  if (sub === "requests" && method === "GET") return { status: 200, data: { requests: listAccountRequests() } };
  const rm = sub.match(/^requests\/([a-z0-9]+)$/i);
  if (rm && method === "POST") {
    const action = body.action === "approve" ? "approved" : (body.action === "decline" ? "declined" : "new");
    const r = setAccountRequestStatus(rm[1], action);
    if (!r) return { status: 404, data: { error: "Request not found." } };
    return { status: 200, data: { ok: true, request: r } };
  }
  // platform-wide leads across every agency
  if (sub === "leads" && method === "GET") {
    const leads = [];
    for (const a of listAgents()) { const ag = getAgency(a.agencyId); for (const q of a.quotes) leads.push({ ...q, agent: a.profile.name, agency: ag ? ag.name : "—", agentSlug: a.slug }); }
    leads.sort((x, y) => y.t - x.t);
    return { status: 200, data: { leads: leads.slice(0, 800) } };
  }
  if (sub === "passcode" && method === "POST") {
    if (!checkPass(String(body.current || ""), dev.passHash)) return { status: 401, data: { error: "Current password is incorrect." } };
    if (String(body.next || "").length < 8) return { status: 400, data: { error: "New password must be at least 8 characters." } };
    setDeveloperPass(String(body.next)); return { status: 200, data: { ok: true } };
  }
  return { status: 404, data: { error: "Not found" } };
}

// ====================================================================
// PAGE RENDERING
// ====================================================================
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderCardPage(agent, req) {
  let html = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
  const P = normalizeProfile(agent.profile);
  const host = req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const base = `${proto}://${host}/a/${agent.slug}`;
  const title = `${P.name || P.brand} · ${P.title}`;
  const desc = `${P.name}${P.brand ? ", " + P.brand : ""}. Tap to verify my license, then call, text, or email.`;
  const img = `${base}/card.png?v=${agent.cardVer || 1}`;
  const tags = {
    "%%AB%%": `/a/${agent.slug}`,
    "%%TITLE%%": esc(title),
    "%%DESC%%": esc(desc),
    "%%OGIMG%%": esc(img),
    "%%OGURL%%": esc(base),
    "%%APPTITLE%%": esc(P.brand || "Meridian"),
  };
  for (const [k, v] of Object.entries(tags)) html = html.replaceAll(k, v);
  // Co-branding: subtle "Powered by Meridian OS" on every agency card.
  const powered = `<div style="width:100%;text-align:center;padding:18px 0 4px;font:600 11px/1 Inter,system-ui,sans-serif;letter-spacing:2.5px;color:#8f7426;opacity:.75">POWERED BY ${esc(platformBrand().toUpperCase())}</div>`;
  // Keep it inside the centered card column (body is a flex row — a sibling would float off to the side).
  html = html.replace("</main>", powered + "</main>");
  return html;
}
function renderAdminPage(agent) {
  let html = fs.readFileSync(path.join(PUB, "admin.html"), "utf8");
  return html.replaceAll("%%AB%%", `/a/${agent.slug}`).replaceAll("%%AGENTNAME%%", esc(agent.profile.name || "Agent"));
}

// per-agent preview image cache (busts when agent.cardVer changes)
const ogCache = new Map();
async function serveCardImage(agent, res) {
  const key = agent.id + ":" + agent.cardVer;
  let buf = ogCache.get(key);
  if (!buf) { buf = await cardPNG(normalizeProfile(agent.profile)); ogCache.set(key, buf); if (ogCache.size > 200) ogCache.delete(ogCache.keys().next().value); }
  res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" }).end(buf);
}

// ====================================================================
// ROUTER
// ====================================================================
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const method = req.method;

    // static assets at root
    if (p === "/favicon.ico") return serveStatic(res, path.join(PUB, "favicon.ico"));
    if (["/logo.svg", "/apple-touch-icon.png", "/favicon-32.png", "/icon-192.png", "/icon-512.png"].includes(p)) return serveStatic(res, path.join(PUB, p.slice(1)));
    if (p === "/manifest.webmanifest" || p === "/admin.webmanifest") return serveStatic(res, path.join(PUB, "manifest.webmanifest"), "no-cache");
    if (p === "/sw.js") { try { const buf = fs.readFileSync(path.join(PUB, "sw.js")); return res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" }).end(buf); } catch { return res.writeHead(404).end(); } }
    if (p === "/api/push/vapid" && method === "GET") return sendJSON(res, 200, { key: await vapidPublicKey() });
    if (p === "/health") return sendJSON(res, 200, { ok: true });
    if (p === "/api/version") return sendJSON(res, 200, { v: BUILD });

    // ---- Unified "three-in-one" front door ----
    // One login for everyone; routes each person to their own dashboard by role.
    if (p === "/api/whoami" && method === "GET") {
      const s = session(req);
      if (s && s.r === "dev" && devSession(req)) return sendJSON(res, 200, { role: "dev", url: "/dev" });
      if (s && s.r === "owner") { const ag = ownerSession(req); if (ag) return sendJSON(res, 200, { role: "owner", url: "/owner" }); }
      if (s && s.r === "agent") { const a = agentSession(req); if (a) return sendJSON(res, 200, { role: "agent", url: "/a/" + a.slug + "/admin" }); }
      return sendJSON(res, 200, { role: null });
    }
    if (p === "/api/login" && method === "POST") {
      if (!sameOrigin(req)) return sendJSON(res, 403, { error: "Not allowed" });
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const pass = String(body.passcode || body.password || "");
      await new Promise((r) => setTimeout(r, 300));
      if (!email || !pass) return sendJSON(res, 400, { error: "Enter your email and password." });
      // 1) developer
      const dev = getDeveloper();
      if (dev && email === dev.email && checkPass(pass, dev.passHash))
        return sendJSON(res, 200, { ok: true, role: "dev", url: "/dev", mustChange: !!dev.mustChange }, { "set-cookie": makeSessionCookie("dev", "dev") });
      // Platform frozen: only the developer (handled above) can get in.
      if (isPlatformFrozen()) return sendJSON(res, 503, { error: "Meridian OS is temporarily unavailable. Please check back shortly." });
      // 2) agency owner
      const ag = getAgencyByOwnerEmail(email);
      if (ag && ag.ownerPassHash) {
        const until = ownerLocked(ag);
        if (until) return sendJSON(res, 423, lockedBody(until, "owner"));
        if (checkPass(pass, ag.ownerPassHash)) { ownerLoginOk(ag.id); return sendJSON(res, 200, { ok: true, role: "owner", url: "/owner", mustChange: !!ag.ownerMustChange }, { "set-cookie": makeSessionCookie("owner", ag.id) }); }
        const lu = ownerLoginFail(ag.id);
        return lu ? sendJSON(res, 423, lockedBody(lu, "owner")) : sendJSON(res, 401, { error: "Email or password is incorrect." });
      }
      // 3) agent
      const agent = getAgentByEmail(email);
      if (agent && agent.passHash) {
        if (agentDenied(agent)) return sendJSON(res, 403, { error: "Your access has been revoked. You can request to have it restored.", denied: true, slug: agent.slug });
        const until = agentLocked(agent);
        if (until) return sendJSON(res, 423, lockedBody(until, "agent"));
        if (checkPass(pass, agent.passHash)) { agentLoginOk(agent.id); return sendJSON(res, 200, { ok: true, role: "agent", url: "/a/" + agent.slug + "/admin", mustChange: !!agent.mustChange }, { "set-cookie": makeSessionCookie("agent", agent.id) }); }
        const lu = agentLoginFail(agent.id);
        return lu ? sendJSON(res, 423, lockedBody(lu, "agent")) : sendJSON(res, 401, { error: "Email or password is incorrect." });
      }
      return sendJSON(res, 401, { error: "Email or password is incorrect." });
    }
    // Public "request an account" — stored for the developer to approve. Never auto-creates access.
    if (p === "/api/request-account" && method === "POST") {
      if (!sameOrigin(req)) return sendJSON(res, 403, { error: "Not allowed" });
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJSON(res, 400, { error: "Please enter your name and a valid email." });
      const r = addAccountRequest({ name, email, phone: body.phone, industry: body.industry, company: body.company, note: body.note });
      try {
        const dev = getDeveloper();
        const to = dev && dev.email;
        if (to) {
          const lines = [`New ${platformBrand()} account request`, "", `Name: ${name}`, `Email: ${email}`, body.phone ? `Phone: ${body.phone}` : "", body.industry ? `Industry: ${body.industry}` : "", body.company ? `Company: ${body.company}` : "", body.note ? `Note: ${body.note}` : "", "", `Review it in your developer console → Onboarding.`].filter(Boolean);
          sendEmail(to, `New account request — ${name}`, lines.join("\n")).catch(() => {});
        }
      } catch {}
      return sendJSON(res, 200, { ok: true, id: r.id });
    }

    // developer API + owner API
    if (p.startsWith("/api/dev/")) {
      const sub = p.slice("/api/dev/".length);
      const body = (method === "GET") ? {} : await readBody(req);
      const r = await handleDev(sub, method, body, req);
      return sendJSON(res, r.status, r.data, r.cookie ? { "set-cookie": r.cookie } : {});
    }
    if (p.startsWith("/api/owner/")) {
      const sub = p.slice("/api/owner/".length);
      const body = (method === "GET") ? {} : await readBody(req);
      const r = await handleOwner(sub, method, body, req);
      return sendJSON(res, r.status, r.data, r.cookie ? { "set-cookie": r.cookie } : {});
    }

    // dashboards
    if (p === "/dev" || p === "/developer") return serveStatic(res, path.join(PUB, "dev.html"), "no-cache");
    if (p === "/" || p === "/login" || p === "/go") return serveStatic(res, path.join(PUB, "login.html"), "no-cache");
    if (p === "/owner") return serveStatic(res, path.join(PUB, "owner.html"), "no-cache");

    // per-agent routes: /a/:slug ...
    const am = p.match(/^\/a\/([a-z0-9-]+)(\/.*)?$/i);
    if (am) {
      const slug = am[1];
      const rest = am[2] || "";
      const agent = getAgentBySlug(slug);
      if (!agent) { res.writeHead(404, { "content-type": "text/html" }).end("<h1>Card not found</h1>"); return; }
      // Agent off-boarded, or their whole agency suspended: never leak the card or its leads.
      // Show a neutral "no longer active" notice (no redirect to any corporate page).
      const ag = agencyOf(agent);
      const live = agent.active && !agent.denied && !isPlatformFrozen() && (!ag || ag.active);
      if (!live && !rest.startsWith("/api/auth") && !rest.startsWith("/admin") && rest !== "/api/request-reinstate") {
        res.writeHead(404, { "content-type": "text/html" }).end("<h1 style='font-family:sans-serif;text-align:center;margin-top:3rem'>This card is no longer active.</h1>"); return;
      }

      if (rest === "" || rest === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }).end(renderCardPage(agent, req));
      if (rest === "/card.png") return serveCardImage(agent, res);
      if (rest === "/photo.jpg") {
        if (!agent.photoVer) { res.writeHead(404).end(); return; }
        try { const buf = fs.readFileSync(path.join(PHOTOS, agent.id + ".jpg")); return res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000" }).end(buf); }
        catch { res.writeHead(404).end(); return; }
      }
      if (rest === "/admin" || rest === "/admin/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }).end(renderAdminPage(agent));

      // agent APIs
      if (rest === "/api/card") return sendJSON(res, 200, await handleCard(agent, url, req));
      if (rest === "/api/quote" && method === "POST") { if (!sameOrigin(req)) return sendJSON(res, 403, { error: "Not allowed" }); return sendJSON(res, 200, await handleQuote(agent, await readBody(req), req)); }
      if (rest === "/api/request-access" && method === "POST") { if (!sameOrigin(req)) return sendJSON(res, 403, { error: "Not allowed" }); return sendJSON(res, 200, await handleRequestAccess(agent, await readBody(req), req)); }
      if (rest === "/api/click" && method === "POST") {
        if (!sameOrigin(req)) return sendJSON(res, 403, { error: "Not allowed" });
        const b = await readBody(req); const t = String(b.type || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
        if (t) { agent.clicks = agent.clicks || {}; agent.clicks[t] = (agent.clicks[t] || 0) + 1; agent.clickTotal = (agent.clickTotal || 0) + 1; save(); }
        return sendJSON(res, 200, { ok: true });
      }
      if (rest === "/api/request-reinstate" && method === "POST") {
        if (!sameOrigin(req)) return sendJSON(res, 403, { error: "Not allowed" });
        if (!agent.denied) return sendJSON(res, 200, { ok: true }); // nothing to do
        requestReinstate(agent.id);
        try { const dev = getDeveloper(); if (dev && dev.email) sendEmail(dev.email, `Reinstatement request — ${agent.profile.name}`, `${agent.profile.name} (${agent.profile.email}) is asking to have their revoked ${platformBrand()} access restored. Review it in your developer console.`).catch(() => {}); } catch {}
        return sendJSON(res, 200, { ok: true });
      }

      if (rest.startsWith("/api/auth/")) {
        const action = rest.split("/").pop();
        const body = method === "GET" ? {} : await readBody(req);
        const r = await handleAgentAuth(agent, action, method, body, req);
        return sendJSON(res, r.status, r.data, r.cookie ? { "set-cookie": r.cookie } : {});
      }
      if (rest.startsWith("/api/admin/")) {
        const authed = agentSession(req);
        if (!authed || authed.id !== agent.id) return sendJSON(res, 401, { error: "Please sign in." });
        if (method !== "GET" && !sameOrigin(req)) return sendJSON(res, 403, { error: "Not allowed" });
        const sub = rest.slice("/api/admin/".length);
        const body = method === "GET" ? {} : await readBody(req);
        const r = await handleAdmin(agent, sub, method, body, req);
        return sendJSON(res, r.status, r.data, r.cookie ? { "set-cookie": r.cookie } : {});
      }
      res.writeHead(404).end("Not found"); return;
    }

    res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
  } catch (e) {
    console.error("server error:", e);
    try { sendJSON(res, 500, { error: "Server error" }); } catch {}
  }
});

server.listen(PORT, () => console.log(`Meridian Team running on :${PORT}`));
