// Web push notifications. Free, app-like alerts to an agent's phone (installed PWA).
// Lazy-loads web-push so the server still runs if the dep is missing; VAPID keys are
// generated once and stored in the data store (no env config needed).
import { db, save } from "./store.js";

let _wp = null;
let _loaded = false;
async function wp() {
  if (_loaded) return _wp;
  _loaded = true;
  try { _wp = (await import("web-push")).default; } catch (e) { console.error("web-push unavailable:", e.message); _wp = null; }
  return _wp;
}

function ensureKeys(w) {
  const d = db();
  if (!d.vapid) { d.vapid = w.generateVAPIDKeys(); save(); }
  return d.vapid;
}

export async function vapidPublicKey() {
  const w = await wp(); if (!w) return null;
  return ensureKeys(w).publicKey;
}

async function configured() {
  const w = await wp(); if (!w) return null;
  const k = ensureKeys(w);
  const subject = process.env.PUSH_CONTACT || ("mailto:" + (process.env.DEV_EMAIL || "alerts@meridian.local"));
  w.setVapidDetails(subject, k.publicKey, k.privateKey);
  return w;
}

export function addSubscription(agent, sub) {
  if (!sub || !sub.endpoint) return false;
  agent.pushSubs = agent.pushSubs || [];
  if (!agent.pushSubs.some((s) => s.endpoint === sub.endpoint)) agent.pushSubs.push(sub);
  if (agent.pushSubs.length > 12) agent.pushSubs = agent.pushSubs.slice(-12);
  save();
  return true;
}

// Fire-and-forget push to all of an agent's devices. Drops dead subscriptions.
export async function pushToAgent(agent, payload) {
  const w = await configured();
  if (!w || !agent.pushSubs || !agent.pushSubs.length) return;
  const data = JSON.stringify(payload);
  const keep = [];
  await Promise.allSettled(agent.pushSubs.map(async (sub) => {
    try { await w.sendNotification(sub, data); keep.push(sub); }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) { /* expired — drop */ } else keep.push(sub); }
  }));
  if (keep.length !== agent.pushSubs.length) { agent.pushSubs = keep; save(); }
}
