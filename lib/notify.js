// Lead alerts — all optional and pluggable.
// EMAIL: Brevo (free, verify a single sender) preferred; Resend supported as a fallback.
//   BREVO_API_KEY + ALERT_EMAIL_FROM="Meridian <you@gmail.com>"   (sender must be a verified Brevo sender)
//   or RESEND_API_KEY + ALERT_EMAIL_FROM
// TEXT: Twilio if configured, otherwise FREE carrier email-to-SMS gateways (needs each agent's carrier).
//   TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM   (paid, ~1c/text)
//   else: the agent's `carrier` turns their number into an email address that arrives as a text.
// Owner copies: OWNER_ALERT_EMAIL, OWNER_ALERT_SMS (a phone gateway address like 5551234567@vtext.com, or a Twilio number).

const E = process.env;

function parseFrom(s) {
  if (!s) return { email: "", name: "Meridian" };
  const m = String(s).match(/^\s*(.*?)\s*<(.+?)>\s*$/);
  if (m) return { name: m[1] || "Meridian", email: m[2].trim() };
  return { email: String(s).trim(), name: "Meridian" };
}

let _smtp = null;
function smtpConfigured() { return !!((E.GMAIL_USER && E.GMAIL_APP_PASSWORD) || (E.SMTP_HOST && E.SMTP_USER && E.SMTP_PASS)); }
async function smtpTransport() {
  if (_smtp) return _smtp;
  const nm = (await import("nodemailer")).default;
  _smtp = nm.createTransport({
    host: E.SMTP_HOST || "smtp.gmail.com",
    port: Number(E.SMTP_PORT || 465),
    secure: Number(E.SMTP_PORT || 465) === 465,
    auth: { user: E.GMAIL_USER || E.SMTP_USER, pass: (E.GMAIL_APP_PASSWORD || E.SMTP_PASS || "").replace(/\s+/g, "") },
    connectionTimeout: 12000, greetingTimeout: 8000, socketTimeout: 15000,
  });
  return _smtp;
}

// Live email health — updated on every real send so the console can warn automatically.
const _health = { lastOk: 0, lastFail: 0, failStreak: 0, lastError: "" };
function recordOk() { _health.lastOk = Date.now(); _health.failStreak = 0; _health.lastError = ""; }
function recordFail(err) { _health.lastFail = Date.now(); _health.failStreak++; _health.lastError = String(err || "send failed").slice(0, 200); }
export function emailHealth() {
  const failing = _health.failStreak >= 2 && (!_health.lastOk || _health.lastFail > _health.lastOk);
  return { ...(_health), failing, configured: smtpConfigured() || !!E.BREVO_API_KEY || !!E.RESEND_API_KEY };
}

// Diagnostics: which sending channels are configured right now.
export function emailStatus() {
  return {
    smtp: smtpConfigured(),
    gmailUser: E.GMAIL_USER || E.SMTP_USER || null,
    brevo: !!E.BREVO_API_KEY, resend: !!E.RESEND_API_KEY,
    from: E.ALERT_EMAIL_FROM || (E.GMAIL_USER ? `Meridian <${E.GMAIL_USER}>` : null),
    ownerEmail: E.OWNER_ALERT_EMAIL || null, ownerSms: E.OWNER_ALERT_SMS || null,
    twilio: !!(E.TWILIO_ACCOUNT_SID && E.TWILIO_AUTH_TOKEN && E.TWILIO_FROM),
  };
}
// Send a test email and report true/false so the developer can verify delivery live.
export async function sendTestEmail(to) { return sendEmail(to, "Meridian OS — test alert ✅", "This is a test from your Meridian OS developer console.\n\nIf you received this, your lead alerts are working. Quotes and appointments will arrive the same way."); }

export async function sendEmail(to, subject, text, html = null) {
  if (!to) return false;
  const from = parseFrom(E.ALERT_EMAIL_FROM);
  const anyProvider = smtpConfigured() || !!E.BREVO_API_KEY || !!E.RESEND_API_KEY;
  let lastErr = "no email provider configured";
  // Gmail / SMTP (your own inbox, sends to anyone, no third-party verification) — preferred when configured
  if (smtpConfigured()) {
    try {
      const t = await smtpTransport();
      const fromAddr = E.ALERT_EMAIL_FROM || `Meridian <${E.GMAIL_USER || E.SMTP_USER}>`;
      await t.sendMail({ from: fromAddr, to, subject: subject || " ", text, ...(html ? { html } : {}) });
      recordOk(); return true;
    } catch (e) { lastErr = "Gmail/SMTP: " + e.message; _smtp = null; console.error("smtp email failed:", e.message); /* fall through to other providers */ }
  }
  // Brevo (free, single verified sender)
  if (E.BREVO_API_KEY && from.email) {
    try {
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": E.BREVO_API_KEY, "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ sender: { email: from.email, name: from.name }, to: [{ email: to }], subject: subject || " ", textContent: text, ...(html ? { htmlContent: html } : {}) }),
      });
      if (r.ok) { recordOk(); return true; } lastErr = "Brevo HTTP " + r.status;
    } catch (e) { lastErr = "Brevo: " + e.message; console.error("brevo email failed:", e.message); }
  }
  // Resend (fallback)
  if (E.RESEND_API_KEY && from.email) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "authorization": `Bearer ${E.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: E.ALERT_EMAIL_FROM, to: [to], subject, text, ...(html ? { html } : {}) }),
      });
      if (r.ok) { recordOk(); return true; } lastErr = "Resend HTTP " + r.status;
    } catch (e) { lastErr = "Resend: " + e.message; console.error("resend email failed:", e.message); }
  }
  if (anyProvider) recordFail(lastErr); // every configured provider failed — flag it for the console
  return false;
}

// Branded black/gold welcome email for a new agent (or agency owner).
export function welcomeEmailHTML({ name, signinUrl, loginEmail, password, cardUrl, origin }) {
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const crest = `${origin}/apple-touch-icon.png`;
  const first = String(name || "there").trim().split(/\s+/)[0];
  const steps = [
    ["1", "Open your dashboard", "Tap the button below to sign in."],
    ["2", "Sign in with the details below", "Use your email and the temporary password."],
    ["3", "Set your own password", "A quick wizard walks you through it — then you're live."],
  ];
  const stepHtml = steps.map(([n, t, d]) =>
    `<tr><td style="width:34px;vertical-align:top;padding:8px 0"><div style="width:26px;height:26px;border-radius:50%;background:#d4af37;color:#231c00;font:700 13px/26px Arial,sans-serif;text-align:center">${n}</div></td>` +
    `<td style="padding:8px 0 8px 10px"><div style="color:#f3efe6;font:600 15px/1.3 Arial,sans-serif">${esc(t)}</div><div style="color:#9a927f;font:400 13px/1.4 Arial,sans-serif;margin-top:2px">${esc(d)}</div></td></tr>`
  ).join("");
  return `<!DOCTYPE html><html><body style="margin:0;background:#0b0b0c;padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#141210;border:1px solid #2a2620;border-radius:16px;overflow:hidden">
    <tr><td style="background:linear-gradient(180deg,#1b1710,#141210);padding:28px 28px 20px;text-align:center;border-bottom:1px solid #2a2620">
      <img src="${crest}" width="58" height="58" alt="Meridian" style="display:block;margin:0 auto 10px;border-radius:50%">
      <div style="color:#d4af37;font:700 12px/1 Arial,sans-serif;letter-spacing:3px;text-transform:uppercase">Meridian</div>
      <div style="color:#f1d78a;font:700 25px/1.2 Georgia,serif;margin-top:8px">Welcome, ${esc(first)}</div>
      <div style="color:#c9c3b5;font:400 14px/1.5 Arial,sans-serif;margin-top:6px">Your digital business card is ready.</div>
    </td></tr>
    <tr><td style="padding:22px 28px 6px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stepHtml}</table>
    </td></tr>
    <tr><td style="padding:6px 28px 4px">
      <div style="background:#0e0c0a;border:1px solid #2a2620;border-radius:12px;padding:14px 16px">
        <div style="color:#9a927f;font:600 11px/1 Arial,sans-serif;letter-spacing:1px;text-transform:uppercase">Your sign-in</div>
        <div style="color:#f3efe6;font:400 15px/1.6 Arial,sans-serif;margin-top:8px">Email: <b style="color:#f1d78a">${esc(loginEmail)}</b></div>
        <div style="color:#f3efe6;font:400 15px/1.6 Arial,sans-serif">Temporary password: <b style="color:#f1d78a;font-family:monospace">${esc(password)}</b></div>
      </div>
    </td></tr>
    <tr><td style="padding:18px 28px 6px;text-align:center">
      <a href="${signinUrl}" style="display:inline-block;background:linear-gradient(180deg,#f1d78a,#d4af37);color:#231c00;font:700 15px/1 Arial,sans-serif;text-decoration:none;padding:15px 32px;border-radius:12px">Open your dashboard →</a>
    </td></tr>
    ${cardUrl ? `<tr><td style="padding:10px 28px 18px;text-align:center"><div style="color:#9a927f;font:400 13px/1.5 Arial,sans-serif">Your card to text out:<br><a href="${cardUrl}" style="color:#d4af37">${esc(cardUrl)}</a><br><span style="color:#6f6a5c">Open it on your phone → Share → Add to Home Screen.</span></div></td></tr>` : ""}
    <tr><td style="padding:14px;text-align:center;border-top:1px solid #2a2620">
      <span style="color:#6f6a5c;font:600 10px/1 Arial,sans-serif;letter-spacing:2px;text-transform:uppercase">Powered by Meridian OS</span>
    </td></tr>
  </table></body></html>`;
}

// Branded black/gold HTML alert for a new lead, with a button into the agent's dashboard.
export function leadEmailHTML(agent, entry, origin) {
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const dash = `${origin}/a/${agent.slug}/admin`;
  const crest = `${origin}/apple-touch-icon.png`;
  const kindLabel = entry.kind === "appointment" ? "New appointment request" : "New quote request";
  const telDigits = String(entry.phone || "").replace(/[^\d]/g, "");
  const ten = telDigits.length === 11 && telDigits[0] === "1" ? telDigits.slice(1) : telDigits;
  const telHref = ten.length === 10 ? "tel:+1" + ten : (telDigits ? "tel:" + telDigits : "");
  const rows = [
    ["Name", entry.name], ["Phone", entry.phone], ["Email", entry.email],
    ["Product", entry.product], ["Coverage", entry.coverage], ["Budget", entry.budget],
    ["When", entry.when], ["Note", entry.note],
  ].filter(([, v]) => v);
  const rowHtml = rows.map(([k, v]) =>
    `<tr><td style="padding:12px 0;border-bottom:1px solid #2b2719;color:#b89b4e;font:600 11px/1.3 Arial,sans-serif;text-transform:uppercase;letter-spacing:1.5px;width:100px;vertical-align:top">${esc(k)}</td>` +
    `<td style="padding:12px 0 12px 16px;border-bottom:1px solid #2b2719;color:#ffffff;font:400 16px/1.45 Georgia,'Times New Roman',serif;vertical-align:top">${esc(v)}</td></tr>`
  ).join("");
  return `<!DOCTYPE html><html><body style="margin:0;background:#000000;padding:28px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#0b0a08;border:1px solid #33301f;border-radius:18px;overflow:hidden;box-shadow:0 6px 30px rgba(0,0,0,.6)">
    <tr><td style="height:3px;background:linear-gradient(90deg,#8f7426,#f1d78a,#8f7426);font-size:0;line-height:0">&nbsp;</td></tr>
    <tr><td style="background:linear-gradient(180deg,#14110a,#0b0a08);padding:32px 28px 24px;text-align:center;border-bottom:1px solid #2a2619">
      <img src="${crest}" width="60" height="60" alt="Meridian OS" style="display:block;margin:0 auto 14px">
      <!--[if mso]><div style="height:4px"></div><![endif]-->
      <div style="color:#d4af37;font:700 11px/1 Arial,sans-serif;letter-spacing:4px;text-transform:uppercase">Meridian OS</div>
      <div style="width:36px;height:1px;background:#8f7426;margin:14px auto"></div>
      <div style="color:#ffffff;font:400 25px/1.25 Georgia,'Times New Roman',serif;letter-spacing:.3px">${esc(kindLabel)}</div>
    </td></tr>
    <tr><td style="padding:26px 30px 28px">
      <p style="color:#d8d2c2;font:400 15px/1.6 Georgia,serif;margin:0 0 20px;text-align:center">A new lead just came in from your card.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowHtml}</table>
      <div style="text-align:center;margin-top:28px">
        <a href="${dash}" style="display:inline-block;background:linear-gradient(180deg,#f1d78a,#d4af37);color:#1a1400;font:700 15px/1 Arial,sans-serif;text-decoration:none;padding:16px 34px;border-radius:12px;letter-spacing:.3px">Open dashboard to quote them →</a>
      </div>
      ${telHref ? `<div style="text-align:center;margin-top:14px"><a href="${telHref}" style="display:inline-block;background:transparent;color:#f1d78a;border:1px solid #8f7426;font:700 15px/1 Arial,sans-serif;text-decoration:none;padding:15px 30px;border-radius:12px;letter-spacing:.3px">Call ${esc(entry.name || "the lead")} →</a></div>` : ""}
      <p style="color:#7a7360;font:400 12px/1.5 Georgia,serif;margin:20px 0 0;text-align:center;font-style:italic">Quote them in your dashboard, then give them a call.</p>
    </td></tr>
    <tr><td style="padding:14px;text-align:center;border-top:1px solid #2a2620">
      <span style="color:#6f6a5c;font:600 10px/1 Arial,sans-serif;letter-spacing:2px;text-transform:uppercase">Powered by Meridian OS</span>
    </td></tr>
  </table></body></html>`;
}

// Carrier email-to-SMS gateways (text-only). Add more as needed.
const GATEWAYS = {
  verizon: "vtext.com", att: "mms.att.net", tmobile: "tmomail.net",
  sprint: "messaging.sprintpcs.com", metro: "mymetropcs.com",
  cricket: "sms.cricketwireless.net", boost: "sms.myboostmobile.com",
  uscellular: "email.uscc.net", googlefi: "msg.fi.google.com",
  xfinity: "vtext.com", straighttalk: "vtext.com", visible: "vtext.com",
  mint: "tmomail.net", consumer: "mailmymobile.net",
};
export const CARRIERS = Object.keys(GATEWAYS);
export function smsGateway(phone, carrier) {
  const g = GATEWAYS[String(carrier || "").toLowerCase()];
  if (!g) return null;
  const d = String(phone || "").replace(/[^\d]/g, "");
  const ten = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  if (ten.length !== 10) return null;
  return ten + "@" + g;
}

export async function sendSMS(to, body) {
  if (!E.TWILIO_ACCOUNT_SID || !E.TWILIO_AUTH_TOKEN || !E.TWILIO_FROM || !to) return false;
  const digits = String(to).replace(/[^\d+]/g, "");
  const toNum = digits.startsWith("+") ? digits : (digits.length === 10 ? "+1" + digits : "+" + digits);
  try {
    const auth = Buffer.from(`${E.TWILIO_ACCOUNT_SID}:${E.TWILIO_AUTH_TOKEN}`).toString("base64");
    const form = new URLSearchParams({ To: toNum, From: E.TWILIO_FROM, Body: body });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${E.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST", headers: { "authorization": `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
    });
    return r.ok;
  } catch (e) { console.error("twilio sms failed:", e.message); return false; }
}

// Send a text to an agent: Twilio if configured, else the free carrier gateway via email.
function fmtPhone(p) {
  const d = String(p || "").replace(/[^\d]/g, "");
  const t = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : String(p || "");
}
function fmtMoney(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/[a-zA-Z/]/.test(s)) return s; // leave things like "$50/mo" or "50k" alone
  const n = s.replace(/[^\d.]/g, "");
  return n ? "$" + Number(n).toLocaleString() : s;
}
// A text channel: gateway (email→SMS, needs a subject so it isn't "/ no subject /") or Twilio (real SMS).
function textAgent(agent, subject, body) {
  if (E.TWILIO_ACCOUNT_SID && E.TWILIO_AUTH_TOKEN && E.TWILIO_FROM) return sendSMS(agent.profile.phone, subject + "\n" + body);
  const gw = smsGateway(agent.profile.phone, agent.carrier);
  if (gw) return sendEmail(gw, subject, body);
  return Promise.resolve(false);
}
function textTo(target, subject, body) {
  if (!target) return Promise.resolve(false);
  return target.includes("@") ? sendEmail(target, subject, body) : sendSMS(target, subject + "\n" + body);
}

// Fire-and-forget alert on a new inbound lead. `extra` = { emails:[], sms:[] } copied recipients; origin = base URL for the dashboard link.
export function alertNewLead(agent, entry, extra = { emails: [], sms: [] }, origin = "") {
  const kind = entry.kind === "appointment" ? "appointment request" : "quote request";
  const bits = [entry.product, entry.coverage && "Coverage " + entry.coverage, entry.budget && "Budget " + entry.budget, entry.when && "When " + entry.when].filter(Boolean).join(" · ");
  const contact = [entry.name, entry.phone, entry.email].filter(Boolean).join(" · ");
  const subject = `New ${kind}${entry.name ? " — " + entry.name : ""}`;
  const text = `You have a new ${kind} from your Meridian card.\n\n${contact}\n${bits}\n${entry.note ? "\nNote: " + entry.note : ""}\n\nOpen your dashboard to respond.`;
  const html = origin ? leadEmailHTML(agent, entry, origin) : null;

  // Clean, organized text alert: subject headline + labeled lines + dashboard link.
  const dashUrl = origin ? `${origin}/a/${agent.slug}/admin` : "";
  const smsSubject = `Meridian: new ${kind}`;
  const smsLines = [
    entry.name ? "Name: " + entry.name : "",
    entry.phone ? "Phone: " + fmtPhone(entry.phone) : "",
    entry.product ? "Wants: " + entry.product : "",
    entry.coverage ? "Coverage: " + fmtMoney(entry.coverage) : "",
    entry.budget ? "Budget: " + fmtMoney(entry.budget) : "",
    entry.when ? "When: " + entry.when : "",
    entry.note ? "Note: " + entry.note : "",
  ].filter(Boolean);
  const smsBody = smsLines.join("\n") + (dashUrl ? `\n\nRespond: ${dashUrl}` : "");

  const tagged = `[${agent.profile.name}] ${subject}`;
  const taggedSub = `[${agent.profile.name}] ${smsSubject}`;
  const jobs = [
    sendEmail(agent.profile.email, subject, text, html),
    textAgent(agent, smsSubject, smsBody),
    E.OWNER_ALERT_EMAIL ? sendEmail(E.OWNER_ALERT_EMAIL, tagged, text, html) : null,
    textTo(E.OWNER_ALERT_SMS, taggedSub, smsBody),
  ];
  // Extra recipients (agency managers + platform-wide CC) copied on the lead
  for (const em of (extra.emails || [])) jobs.push(sendEmail(em, tagged, text, html));
  for (const s of (extra.sms || [])) jobs.push(textTo(s, taggedSub, smsBody));
  Promise.allSettled(jobs).catch(() => {});
}
