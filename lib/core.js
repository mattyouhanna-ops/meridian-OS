// Shared logic ported from the single-agent card: profiles, products, settings, auth, sessions.
import crypto from "node:crypto";
import { db, save } from "./store.js";

// ---------- Content defaults ----------
export const DEFAULT_PROMISES = [
  { t: "Licensed and accountable.", d: "I'm regulated by the state. If I ever do you wrong, you can report me to the Department of Insurance — and that's how it should be." },
  { t: "I work for you, not one company.", d: "I shop multiple top-rated carriers to find the right coverage at the best price for your family." },
  { t: "Your money goes to the carrier only.", d: "Premiums are paid directly to the insurance company, never to me. I will never ask for cash, gift cards, Zelle, Cash App, wire transfers or crypto." },
  { t: "No pressure, ever.", d: "Nothing is final until you understand it and sign it. Take your time and ask every question." },
  { t: "Free-look guarantee.", d: "After your policy is delivered, you get a free-look period to cancel for a full refund. Your state sets how long it lasts." },
  { t: "I pick up the phone.", d: "Before and after the sale, when you need help with a claim or a change, you call me and I answer." },
];
export const DEFAULT_PRODUCTS = [
  { t: "Final Expense", d: "Covers funeral and end-of-life costs so your family isn't left with the bill. Simple approval, no big medical exam." },
  { t: "Term Life / Mortgage Protection", d: "Affordable protection for a set number of years — ideal while the kids are home or the mortgage is open — so your family keeps the house if something happens to you." },
  { t: "Whole Life", d: "Permanent coverage with guaranteed premiums that builds cash value you can borrow against." },
  { t: "Indexed Universal Life (IUL)", d: "Lifelong protection with flexible premiums and cash value growth linked to a market index, with downside protection." },
  { t: "Annuities", d: "Coming soon. Turn savings into guaranteed, tax-deferred growth and retirement income you can't outlive — ask me and I'll let you know the moment it's available." },
  { t: "Mortgage", d: "Coming soon. Home purchase and refinance help through my mortgage side — ask me and I'll let you know when it's live in your area." },
  { t: "Health Insurance", d: "Coming soon. Ask me and I'll let you know the moment it's available in your state." },
];

export function normalizeProfile(p = {}) {
  const digits = String(p.phone || "").replace(/[^\d]/g, "");
  return {
    name: String(p.name || "").trim().slice(0, 80),
    title: String(p.title || "Licensed Life Insurance Agent").trim().slice(0, 80),
    brand: String(p.brand || "Meridian Life Group").trim().slice(0, 80),
    phone: String(p.phone || "").trim().slice(0, 40),
    phoneTel: digits ? (digits.length === 10 ? "+1" + digits : "+" + digits) : "",
    email: String(p.email || "").trim().toLowerCase().slice(0, 120),
    npn: String(p.npn || "").replace(/[^\dA-Za-z]/g, "").slice(0, 20),
    states: Array.isArray(p.states) ? p.states.map((s) => String(s).toUpperCase()).slice(0, 56) : [],
    promises: Array.isArray(p.promises) && p.promises.length ? p.promises.slice(0, 12).map((x) => ({ t: String(x.t || "").slice(0, 80), d: String(x.d || "").slice(0, 300) })) : DEFAULT_PROMISES,
    products: Array.isArray(p.products) && p.products.length ? p.products.slice(0, 12).map((x) => ({ t: String(x.t || "").slice(0, 60), d: String(x.d || "").slice(0, 300) })) : DEFAULT_PRODUCTS,
  };
}

export const FIELDS = {
  phone: "Phone number (Call / Text)",
  email: "Email address",
  npn: "NPN / license number",
  states: "State license lookups",
  nipr: "NIPR national registry option",
  lastResort: "Last-resort verification options",
  products: "How I can help (products)",
  promise: "My promise to you",
};

export const DEFAULT_MESSAGE = "Hi {first}, it's {me}. Here's my digital card. You can verify my license and reach me anytime: {link}";
export const DEFAULT_SETTINGS = {
  defaultAudience: "prospect",
  sendMessage: DEFAULT_MESSAGE,
  mainLimited: false,
  audiences: {
    prospect: { label: "New prospects", fields: { phone: true, email: true, npn: false, states: true, nipr: false, lastResort: true, products: true, promise: true } },
    client:   { label: "Active clients", fields: { phone: true, email: true, npn: true, states: true, nipr: true, lastResort: true, products: true, promise: true } },
  },
};

export function normalizeSettings(s) {
  if (!s) return structuredClone(DEFAULT_SETTINGS);
  if (typeof s.mainLimited !== "boolean") s.mainLimited = false;
  if (typeof s.sendMessage !== "string" || !s.sendMessage.trim()) s.sendMessage = DEFAULT_MESSAGE;
  s.audiences ||= {};
  for (const a of Object.keys(DEFAULT_SETTINGS.audiences)) {
    s.audiences[a] ||= structuredClone(DEFAULT_SETTINGS.audiences[a]);
    s.audiences[a].fields ||= {};
    for (const f of Object.keys(FIELDS)) if (typeof s.audiences[a].fields[f] !== "boolean") s.audiences[a].fields[f] = DEFAULT_SETTINGS.audiences[a].fields[f];
  }
  s.defaultAudience ||= "prospect";
  return s;
}

export function cleanFields(input) {
  const out = {};
  for (const f of Object.keys(FIELDS)) out[f] = !!(input && input[f]);
  return out;
}

// ---------- Device / visitor ----------
export function describeDevice(ua = "") {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows PC" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : /CrOS/.test(ua) ? "Chromebook" : "Unknown device";
  const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${os} · ${br}`;
}

// ---------- Password hashing (PBKDF2-SHA256) ----------
export function hashPass(pass, saltHex = crypto.randomBytes(16).toString("hex")) {
  const h = crypto.pbkdf2Sync(pass, Buffer.from(saltHex, "hex"), 210000, 32, "sha256").toString("hex");
  return `${saltHex}:${h}`;
}
export function checkPass(pass, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, h] = stored.split(":");
  const test = hashPass(pass, salt).split(":")[1];
  try { return crypto.timingSafeEqual(Buffer.from(test, "hex"), Buffer.from(h, "hex")); } catch { return false; }
}

// ---------- Sessions (HMAC-signed cookie). Secret generated once, kept in the store. ----------
const SECURE = process.env.INSECURE_COOKIES !== "1";
const COOKIE = SECURE ? "__Host-mc_session" : "mc_session";
const SESSION_HOURS = 12;
function secret() {
  const d = db();
  if (!d.secret) { d.secret = crypto.randomBytes(48).toString("hex"); save(); }
  return d.secret;
}
const b64u = (b) => Buffer.from(b).toString("base64url");

export function makeSessionCookie(role, id) {
  const payload = b64u(JSON.stringify({ r: role, id, x: Date.now() + SESSION_HOURS * 3600e3, v: 1 }));
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const flags = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}` + (SECURE ? "; Secure" : "");
  return `${COOKIE}=${payload}.${sig}; ${flags}`;
}
export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` + (SECURE ? "; Secure" : "");

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export function readSession(cookieHeader) {
  const raw = parseCookies(cookieHeader || "")[COOKIE];
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", secret()).update(payload).digest();
  let got; try { got = Buffer.from(sig, "base64url"); } catch { return null; }
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
  let data; try { data = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return null; }
  if (Date.now() > data.x) return null;
  return data; // { r: 'owner'|'agent', id, x }
}

// ---------- Slug ----------
export function slugify(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}
