// Dynamic per-agent business-card preview image (the picture that unfurls in a text).
// Built from an SVG + the Meridian crest, rasterized to PNG with sharp.
// Fonts are bundled (lib/fonts) and registered via fontconfig so it renders the same on any server.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(HERE, "fonts");

// Point fontconfig at the bundled fonts BEFORE sharp/libvips initializes its text renderer.
try {
  const confDir = path.join(process.env.DATA_DIR || process.cwd(), ".fonts-conf");
  fs.mkdirSync(confDir, { recursive: true });
  const confFile = path.join(confDir, "fonts.conf");
  fs.writeFileSync(confFile, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <cachedir>${path.join(confDir, "cache")}</cachedir>
  <match target="pattern"><test name="family"><string>serif</string></test><edit name="family" mode="prepend" binding="strong"><string>DejaVu Serif</string></edit></match>
  <match target="pattern"><test name="family"><string>sans-serif</string></test><edit name="family" mode="prepend" binding="strong"><string>DejaVu Sans</string></edit></match>
</fontconfig>`);
  if (!process.env.FONTCONFIG_FILE) process.env.FONTCONFIG_FILE = confFile;
} catch (e) { console.error("font setup:", e.message); }

const sharp = (await import("sharp")).default;

const CREST_DATA = (() => {
  try { return "data:image/png;base64," + fs.readFileSync(path.join(HERE, "crest.png")).toString("base64"); }
  catch { return ""; }
})();

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const W = 1200, H = 630;
const GOLD = "#d4af5a", GOLD_SOFT = "#be9e5c", CREAM = "#eee2c6", MUTE = "#968c76", BG = "#0a0908";

// Build the contact line, splitting with gold dots. Returns SVG <tspan> markup.
function contactSpans(parts) {
  return parts.map((p, i) =>
    (i ? `<tspan dx="20" fill="${GOLD}">&#8226;</tspan>` : "") + `<tspan dx="${i ? 20 : 0}" fill="${MUTE}">${esc(p)}</tspan>`
  ).join("");
}

export async function cardPNG(profile, opts = {}) {
  const licensed = opts.licensed !== false;
  const name = profile.name || profile.brand || "Meridian Life Group";
  const rawTitle = licensed ? (profile.title || "Licensed Insurance Agent")
    : ((profile.title || "").replace(/licensed/ig, "").trim() || "Agent in Training");
  const title = rawTitle.toUpperCase();
  const parts = [profile.phone, profile.email, licensed && profile.npn ? "NPN " + profile.npn : ""].filter(Boolean);
  const titleSpaced = esc(title).split("").join(" "); // thin-space letter-spacing

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="g" cx="50%" cy="18%" r="55%">
      <stop offset="0%" stop-color="#1a160e"/><stop offset="100%" stop-color="${BG}"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect x="26" y="26" width="${W - 52}" height="${H - 52}" fill="none" stroke="#463a1e" stroke-width="2"/>
  <rect x="34" y="34" width="${W - 68}" height="${H - 68}" fill="none" stroke="${GOLD}" stroke-width="1"/>
  ${CREST_DATA ? `<image href="${CREST_DATA}" x="${(W - 168) / 2}" y="60" width="168" height="168"/>` : ""}
  <text x="${W / 2}" y="310" text-anchor="middle" font-family="serif" font-weight="bold" font-size="60" fill="${CREAM}">${esc(name)}</text>
  <line x1="${W / 2 - 90}" y1="340" x2="${W / 2 + 90}" y2="340" stroke="${GOLD}" stroke-width="2"/>
  <text x="${W / 2}" y="388" text-anchor="middle" font-family="sans-serif" font-size="23" fill="${GOLD_SOFT}" letter-spacing="3">${titleSpaced}</text>
  ${parts.length ? `<text x="${W / 2}" y="446" text-anchor="middle" font-family="sans-serif" font-size="25" letter-spacing="1">${contactSpans(parts)}</text>` : ""}
  <text x="${W / 2}" y="578" text-anchor="middle" font-family="sans-serif" font-size="19" fill="${GOLD_SOFT}" letter-spacing="2">${licensed ? "TAP TO VERIFY LICENSE&#160;&#160;&#160;&#183;&#160;&#160;&#160;CALL&#160;&#160;&#160;&#183;&#160;&#160;&#160;TEXT&#160;&#160;&#160;&#183;&#160;&#160;&#160;EMAIL" : "CALL&#160;&#160;&#160;&#183;&#160;&#160;&#160;TEXT&#160;&#160;&#160;&#183;&#160;&#160;&#160;EMAIL"}</text>
</svg>`;

  return await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}
