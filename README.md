# ⚡ VELOCITY SPORTS — Football Prediction App

Pre-match football predictions powered by the [football-data.org](https://www.football-data.org) API, with a client-side heuristic engine that only surfaces outcomes meeting a **75% confidence threshold**.

Deploys **zero-config on Vercel** — static frontend + a tiny serverless API proxy that keeps your API key secure.

---

## ✨ Features

- **Live fixtures for 6 competitions** — Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League
- **Three prediction markets** — 1X2 (Match Result), Over/Under (1.5 / 2.5 / 3.5), Double Chance
- **75% threshold filtering** — only high-confidence outcomes appear in the recommendation banner; all qualifying picks are listed (e.g., `Home Win 78% + Over 1.5 84%`)
- **Smart caching** — fixtures, standings, and team form are cached in `localStorage` (5-minute TTL) to stay well within the free-tier rate limit
- **Dark-mode UI** — deep charcoal theme, green/gold accents, bottom navigation, searchable fixture cards, expandable prediction accordions

---

## 📁 Project Structure

```
predictor/
├── index.html           # Main UI (top nav, search, tabs, match cards, bottom nav)
├── style.css            # Modular dark theme styling & responsive layout
├── app.js               # Three-layer logic:
│                        #   DataFetcher      — proxy fetch + localStorage cache
│                        #   PredictionEngine — heuristic probability models
│                        #   UIRenderer       — DOM rendering & interactions
├── api/
│   └── football.js      # Vercel serverless proxy → api.football-data.org/v4
│                        # (key stays server-side, never exposed to the browser)
├── vercel.json          # Optional: cache headers for /api responses
├── .env.example         # Template for FOOTBALL_DATA_API_KEY
├── .gitignore           # Protects .env from ever being committed
└── README.md
```

### Architecture

| Layer | File | Responsibility |
|-------|------|----------------|
| UI / Presentation | `index.html`, `style.css`, `UIRenderer` (in `app.js`) | Rendering, layout, interaction |
| Logic / Services | `PredictionEngine`, `MatchEnricher`, `AppController` | Heuristic analysis, filtering, state |
| Data | `DataFetcher`, `api/football.js` | API access, caching, secure proxying |

Functions are kept under ~30 lines (Rule of 30), and layers are modular so each concern is easy to swap or test.

---

## 🧠 How Predictions Work

1. On load, the app fetches **upcoming fixtures** and **league standings** for the selected competition (one API round trip, cached for 5 minutes).
2. It then fetches **recent form** (last 5 finished matches) for each team — cached per team.
3. The engine combines:
   - league **points** and **position** from standings,
   - normalized **form score** from the last 5 results
4. A symmetric strength model assigns probabilities for **Home / Draw / Away**, then derives Over/Under and Double Chance markets.
5. Any pick at **≥ 75%** is showcased in the card's recommendation banner — *all* qualifying picks are shown (e.g., `W1 82% + Over 2.5 76%`).

> ⚠️ **Disclaimer:** These are heuristic estimates for entertainment and analysis — not financial or betting advice. Always gamble responsibly.

---

## 🚀 Local Development

1. **Get an API key** at [football-data.org/client/register](https://www.football-data.org/client/register) (free tier: 10 requests/min).
2. Copy the example env file:
   ```bash
   cp .env.example .env
   ```
3. Paste your key into `.env`:
   ```
   FOOTBALL_DATA_API_KEY=your-key-here
   ```
4. Serve the project locally. The serverless proxy needs a Node runtime — the easiest options:

   **Option A — Vercel CLI (recommended):**
   ```bash
   npx vercel dev
   # → http://localhost:3000
   ```

   **Option B — Any static server + custom proxy:**
   ```bash
   # Serve static files
   npx serve .
   ```
   Note: `api/football.js` only runs when deployed on Vercel (or via `vercel dev`), because it relies on Vercel's function runtime.

---

## 🌍 Deploying to GitHub & Vercel

### Step 1 — Initialize & commit in `C:\Projects\predictor`

```bash
cd C:\Projects\predictor
git init
git add .
git commit -m "Initial commit: VELOCITY SPORTS prediction app"
```

> `.gitignore` already excludes `.env` and `node_modules`, so your API key can never be committed.

### Step 2 — Push to GitHub

```bash
git remote add origin https://github.com/joyboy64209/predictor.git
git branch -M main
git push -u origin main
```

### Step 3 — Import into Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Select the **predictor** repository from your GitHub account
3. Framework preset: **Other** (static — zero configuration required)
4. Click **Deploy**

### Step 4 — Set the environment variable & redeploy

1. In your Vercel project, go to **Settings → Environment Variables**
2. Add the environment variable:
   | Name | Value |
   |------|-------|
   | `FOOTBALL_DATA_API_KEY` | `your-football-data-api-key` |

   (Use the key you registered at football-data.org.)
3. Redeploy (or the default production deploy will pick it up) — the app is live. 🎉

> ⚠️ **Never put the real key in this README or anywhere in the repo** — the repository is public, and anyone could steal and abuse it. It belongs only in Vercel's Environment Variables.

---

## 🔐 Security Notes

- The API key is **only read server-side** inside `api/football.js` via `process.env.FOOTBALL_DATA_API_KEY`.
- The browser never sees the key — the frontend only talks to `/api/football`, which forwards requests with the `X-Auth-Token` header.
- Network calls to the upstream API are **rate-limited** by the free tier (10/min). Caching + Vercel's CDN cache (`s-maxage=300`) keep usage low.

---

## 🛠 Customization

- **Change the confidence threshold:** edit `THRESHOLD` in the `CONFIG` object at the top of `app.js`.
- **Add a competition:** add `{ code: '..', name: '...' }` to `COMPETITIONS` + a matching tab button in `index.html`.
- **Extend markets:** add new generators alongside `_overUnderMarkets` in `PredictionEngine`.

---

MIT © 2026 VELOCITY SPORTS