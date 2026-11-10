// Email + SMS alerts. Fully optional and pluggable: if the relevant env vars aren't set,
// the matching channel is skipped silently (nothing breaks). Works on Railway with Resend + Twilio.
//   Email  : RESEND_API_KEY, ALERT_EMAIL_FROM   (e.g. "Meridian <alerts@yourdomain.com>")
//   SMS    : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM  (e.g. +1313...)
//   Owner copy (optional): OWNER_ALERT_EMAIL, OWNER_ALERT_SMS
// Each agent is alerted at their own card email/phone; the owner optionally gets a copy.

const E = process.env;

export async function sendEmail(to, subject, text) {
  if (!E.RESEND_API_KEY || !E.ALERT_EMAIL_FROM || !to) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "authorization": `Bearer ${E.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: E.ALERT_EMAIL_FROM, to: [to], subject, text }),
    });
    return r.ok;
  } catch (e) { console.error("email alert failed:", e.message); return false; }
}

export async function sendSMS(to, body) {
  if (!E.TWILIO_ACCOUNT_SID || !E.TWILIO_AUTH_TOKEN || !E.TWILIO_FROM || !to) return false;
  const digits = String(to).replace(/[^\d+]/g, "");
  const toNum = digits.startsWith("+") ? digits : (digits.length === 10 ? "+1" + digits : "+" + digits);
  try {
    const auth = Buffer.from(`${E.TWILIO_ACCOUNT_SID}:${E.TWILIO_AUTH_TOKEN}`).toString("base64");
    const form = new URLSearchParams({ To: toNum, From: E.TWILIO_FROM, Body: body });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${E.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: { "authorization": `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    return r.ok;
  } catch (e) { console.error("sms alert failed:", e.message); return false; }
}

// Fire-and-forget: alert an agent (and optionally the owner) about a new inbound lead.
export function alertNewLead(agent, entry) {
  const kind = entry.kind === "appointment" ? "appointment request" : "quote request";
  const bits = [entry.product, entry.coverage && "Coverage " + entry.coverage, entry.budget && "Budget " + entry.budget, entry.when && "When " + entry.when].filter(Boolean).join(" · ");
  const contact = [entry.name, entry.phone, entry.email].filter(Boolean).join(" · ");
  const subject = `New ${kind}${entry.name ? " — " + entry.name : ""}`;
  const text = `You have a new ${kind} from your Meridian card.\n\n${contact}\n${bits}\n${entry.note ? "\nNote: " + entry.note : ""}\n\nOpen your dashboard to respond.`;
  const sms = `Meridian: new ${kind}${entry.name ? " from " + entry.name : ""}. ${bits || ""}${entry.phone ? " " + entry.phone : ""}`.slice(0, 300);

  // Don't block the response — run in the background.
  Promise.allSettled([
    sendEmail(agent.profile.email, subject, text),
    sendSMS(agent.profile.phone, sms),
    E.OWNER_ALERT_EMAIL ? sendEmail(E.OWNER_ALERT_EMAIL, `[${agent.profile.name}] ${subject}`, text) : null,
    E.OWNER_ALERT_SMS ? sendSMS(E.OWNER_ALERT_SMS, `[${agent.profile.name}] ${sms}`) : null,
  ]).catch(() => {});
}
