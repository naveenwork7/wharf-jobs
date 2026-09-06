# Wharf — UAE Fresher Jobs (GitHub Pages + hosted backend)

This app has **two parts that deploy separately**:

| Part | Folder | Where it runs |
|---|---|---|
| Frontend (UI) | `frontend/index.html` | **GitHub Pages** |
| Backend (live search + AI) | `backend/server.js` | **Render** (or Railway / Fly.io) |

**Why two parts?** GitHub Pages only serves static files — it cannot run a Node.js
server. Your Tavily and Anthropic API keys must live on a real server, never in
client-side code, or anyone visiting your site can steal them from dev tools.

---

## Step 1 — Deploy the backend (do this first)

1. Get free API keys:
   - Tavily: https://tavily.com (free tier)
   - Anthropic: https://console.anthropic.com
2. Push this whole project to a GitHub repo (see Step 3 below first if you want
   one repo for both parts — that's fine, Render can be pointed at a subfolder).
3. Go to https://render.com → sign up (free) → **New + → Web Service**.
4. Connect your GitHub repo.
5. Configure the service:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
6. Add Environment Variables in Render's dashboard (not in a committed file):
   - `TAVILY_API_KEY` = your Tavily key
   - `ANTHROPIC_API_KEY` = your Anthropic key
   - `ALLOWED_ORIGIN` = `*` for now (tighten this in Step 4)
7. Deploy. Render gives you a public URL like:
   `https://wharf-backend-xxxx.onrender.com`
8. Visit that URL in your browser — you should see:
   `{"status":"ok","service":"wharf-backend","endpoint":"POST /api/jobs"}`
   If you see that, your backend is live.

> **Free tier note:** Render's free web services sleep after ~15 min of no
> traffic and take ~30–60s to wake on the next request. That's fine for a demo;
> for something always-on, upgrade the plan or ping it periodically.

---

## Step 2 — Point the frontend at your backend

Open `frontend/index.html`, find this near the top of the `<script>` block:

```js
const BACKEND_BASE_URL = "https://YOUR-BACKEND-URL-HERE.onrender.com";
```

Replace it with the real URL from Step 1, e.g.:

```js
const BACKEND_BASE_URL = "https://wharf-backend-xxxx.onrender.com";
```

Save the file.

---

## Step 3 — Publish the frontend on GitHub Pages

1. Create a new GitHub repo (or reuse the one from Step 1).
2. Push this project to it:
   ```bash
   git init
   git add .
   git commit -m "Wharf: UAE fresher jobs app"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Branch: `main`, folder: `/frontend` (GitHub Pages supports serving from a
   subfolder like this — if your Pages setup only allows `/` or `/docs`, rename
   the `frontend` folder to `docs` and pick that instead).
6. Save. GitHub gives you a URL like:
   `https://YOUR-USERNAME.github.io/YOUR-REPO/`
7. Wait a minute for it to build, then open it.

---

## Step 4 — Lock the backend down to your GitHub Pages URL (recommended)

Right now `ALLOWED_ORIGIN=*` lets any website call your backend and burn your
API quota. Once your Pages URL is live:

1. Go back to Render → your service → **Environment**.
2. Set `ALLOWED_ORIGIN` to your exact Pages URL, e.g.:
   `https://YOUR-USERNAME.github.io`
3. Save — Render redeploys automatically.

---

## How it behaves

- Type a role in the search box, press **Enter** to add it as a tag — add up
  to 6 roles, then click **Search now**.
- Results are live: the backend runs a real Tavily web search across LinkedIn,
  Bayt, Indeed UAE, GulfTalent, Naukrigulf, and Monster Gulf, then Claude
  filters/structures the raw results into fresher-only, UAE-only, last-3-days
  listings. Nothing is hardcoded.
- The page auto-refreshes every 5 minutes using the same role list, and the
  **Search now** button always forces a brand-new search.
- The backend also keeps a 3-minute shared cache per role combination, so
  multiple visitors searching the same roles around the same time don't each
  trigger a separate paid API call.

## Local testing (optional, before deploying)

```bash
cd backend
npm install
cp .env.example .env   # then fill in your real keys in .env
npm start
```

Then temporarily set `BACKEND_BASE_URL = "http://localhost:3001"` in
`frontend/index.html` and open that file directly in a browser to test end to
end before deploying either piece.

## Troubleshooting

- **"Couldn't reach the job search backend"** → `BACKEND_BASE_URL` is wrong,
  or the Render service is asleep (first request after idle can take up to a
  minute — try clicking Search now again).
- **CORS error in browser console** → `ALLOWED_ORIGIN` on Render doesn't match
  your GitHub Pages URL exactly (no trailing slash, must include `https://`).
- **Empty results every time** → check Render's logs for the actual Tavily /
  Anthropic error (bad key, quota exceeded, etc.) — the frontend deliberately
  shows a generic message so it never leaks API internals.
