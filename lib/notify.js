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

export async function sendEmail(to, subject, text) {
  if (!to) return false;
  const from = parseFrom(E.ALERT_EMAIL_FROM);
  // Brevo (preferred, free)
  if (E.BREVO_API_KEY && from.email) {
    try {
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": E.BREVO_API_KEY, "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ sender: { email: from.email, name: from.name }, to: [{ email: to }], subject: subject || " ", textContent: text }),
      });
      return r.ok;
    } catch (e) { console.error("brevo email failed:", e.message); return false; }
  }
  // Resend (fallback)
  if (E.RESEND_API_KEY && from.email) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "authorization": `Bearer ${E.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: E.ALERT_EMAIL_FROM, to: [to], subject, text }),
      });
      return r.ok;
    } catch (e) { console.error("resend email failed:", e.message); return false; }
  }
  return false;
}

// Carrier email-to-SMS gateways (text-only). Add more as needed.
const GATEWAYS = {
  verizon: "vtext.com", att: "txt.att.net", tmobile: "tmomail.net",
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
function textAgent(agent, body) {
  if (E.TWILIO_ACCOUNT_SID && E.TWILIO_AUTH_TOKEN && E.TWILIO_FROM) return sendSMS(agent.profile.phone, body);
  const gw = smsGateway(agent.profile.phone, agent.carrier);
  if (gw) return sendEmail(gw, "", body); // arrives as a text
  return Promise.resolve(false);
}
function textOwner(body) {
  if (!E.OWNER_ALERT_SMS) return Promise.resolve(false);
  // If it's an email gateway address, send via email; if it's a phone number, use Twilio.
  return E.OWNER_ALERT_SMS.includes("@") ? sendEmail(E.OWNER_ALERT_SMS, "", body) : sendSMS(E.OWNER_ALERT_SMS, body);
}

// Fire-and-forget alert on a new inbound lead. `extra` = { emails:[], sms:[] } copied for the whole agency.
export function alertNewLead(agent, entry, extra = { emails: [], sms: [] }) {
  const kind = entry.kind === "appointment" ? "appointment request" : "quote request";
  const bits = [entry.product, entry.coverage && "Coverage " + entry.coverage, entry.budget && "Budget " + entry.budget, entry.when && "When " + entry.when].filter(Boolean).join(" · ");
  const contact = [entry.name, entry.phone, entry.email].filter(Boolean).join(" · ");
  const subject = `New ${kind}${entry.name ? " — " + entry.name : ""}`;
  const text = `You have a new ${kind} from your Meridian card.\n\n${contact}\n${bits}\n${entry.note ? "\nNote: " + entry.note : ""}\n\nOpen your dashboard to respond.`;
  const sms = `Meridian: new ${kind}${entry.name ? " from " + entry.name : ""}. ${bits || ""}${entry.phone ? " " + entry.phone : ""}`.slice(0, 300);

  const tagged = `[${agent.profile.name}] ${subject}`;
  const jobs = [
    sendEmail(agent.profile.email, subject, text),
    textAgent(agent, sms),
    E.OWNER_ALERT_EMAIL ? sendEmail(E.OWNER_ALERT_EMAIL, tagged, text) : null,
    textOwner(`[${agent.profile.name}] ${sms}`),
  ];
  // Agency-level extra recipients (e.g. a manager copied on their team's leads)
  for (const em of (extra.emails || [])) jobs.push(sendEmail(em, tagged, text));
  for (const s of (extra.sms || [])) jobs.push(s.includes("@") ? sendEmail(s, "", sms) : sendSMS(s, `[${agent.profile.name}] ${sms}`));
  Promise.allSettled(jobs).catch(() => {});
}
