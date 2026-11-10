# Meridian Team Platform

One app that runs the whole team: an **owner dashboard** that controls every agent, plus a **per-agent digital business card** and **agent dashboard**. Every agent's texted link automatically unfurls as their own black/gold Meridian business card (generated on the server), and the Meridian crest is the Add-to-Home-Screen icon for everyone.

## What's here
- `server.js` — the whole server (Node built-ins + `sharp`).
- `lib/` — storage, auth, model (owner + agents), dynamic card-image generator, state lookups, bundled fonts, crest.
- `public/` — the card (`index.html`), agent dashboard (`admin.html`), owner dashboard (`owner.html`), icons, manifest.
- `data/` — created at runtime; holds everything. Put this on a Railway Volume so it survives redeploys.

## URLs
- `/` — owner dashboard (sign in, manage agents, team inbox).
- `/a/<agent>` — that agent's card (what they text out).
- `/a/<agent>/admin` — that agent's own dashboard.
- `/a/<agent>/card.png` — the auto-generated business-card preview image.

## Run locally
```
npm install
INSECURE_COOKIES=1 OWNER_PASSWORD=test1234 npm start
# open http://localhost:3000
```

## Deploy
See **DEPLOY-RAILWAY.html** for click-by-click steps. Short version:
1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub → pick the repo.
3. Add a **Volume** mounted at `/data`, and set `DATA_DIR=/data`.
4. Set `OWNER_EMAIL` and a strong `OWNER_PASSWORD` in Variables.
5. Open the Railway URL → sign in → add your agents.

First owner login uses `OWNER_EMAIL` / `OWNER_PASSWORD`. Change the password in Settings after first sign-in.
