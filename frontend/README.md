# Understudy: demo frontend

The browser UI for **Understudy**, built by team e/acc for the Awign Hackathon (Open Theme).

Gig workers send support tickets in English (payment delays, deductions, KYC, app issues, task assignment and ratings, safety). A local Gemma 4 model classifies each ticket into a category and a priority, which decides the team. When it is unsure it asks a cloud teacher model. The teacher's answers become training data, LoRA training rounds make Gemma better, and so the share handled locally rises while the cloud cost falls. Offline, unsure tickets go to a human review queue instead.

This app shows that loop live. It makes **no external requests at runtime** (system fonts, no CDN, no images from the web), so it keeps working with Wi-Fi turned off.

## Stack

- Next.js 16 (App Router), React 19, TypeScript
- Tailwind CSS v4 (design tokens in `src/app/globals.css`)
- Recharts 3 for charts, `motion` (`motion/react`) for animation; reduced-motion is respected
- No state library: one store (`src/lib/store.tsx`) behind `useStore()`

## Quick start

Open WebUI already uses port 3000 and the backend uses port 8000, so this app runs on **3001**.

```bash
cd frontend
cp .env.example .env.local
npm install
npm run build && npm start -- -p 3001
```

Then open http://localhost:3001.

For development with hot reload:

```bash
npm run dev -- -p 3001
```

Use the production build (`npm start`) for the actual demo: it is faster and has no dev overlay.

## Environment variables

Set in `.env.local` (copy from `.env.example`). `NEXT_PUBLIC_*` values are **baked in at build time**, so rebuild after changing them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:8000` | Base URL of the FastAPI backend. On Vercel this is the cloudflared tunnel URL. |
| `NEXT_PUBLIC_DATA_SOURCE` | `api` | `api` = use the live backend, falling back to the newest saved snapshot (browser cache or bundled `public/export/snapshot.json`) with a **SNAPSHOT** badge when it is unreachable. `snapshot` = never call the API; show the bundled snapshot only. |

To run against the real backend, make sure it is up on :8000. Refresh the bundled snapshot with `npm run sync:snapshot`.

## API contract

All paths are relative to `NEXT_PUBLIC_API_URL`.

| Method and path | Returns / does |
| --- | --- |
| `GET /api/health` | `{status, model_version, mode}` |
| `POST /api/classify` `{text}` | One classification: `{id, category, category_name, priority, team, source, confidence, latency_ms, cost_usd, model_version}` |
| `GET /api/metrics/summary` | `{total, local_share, teacher_share, review_share, cost_usd_total, cost_avoided_usd, model_version, mode}` |
| `GET /api/metrics/timeseries` | `[{t, local_share, cost_cumulative, cost_cloud_only_cumulative}]` |
| `GET /api/tickets/recent?limit=N` | Newest-first tickets (classification fields plus `text`, `created_at`) |
| `GET /api/review_queue` | `[{id, text, created_at}]` |
| `GET /api/rounds` | Training rounds with loss curve, eval, cost, `promoted` and `reason` |
| `GET /api/eval/compare` | Base vs trained vs teacher vs router: accuracy, macro F1, latency, cost per 1k, per-category F1, confusion matrices, `provisional` flag |
| `GET /api/snapshot` | Everything above in one payload plus `generated_at` |
| `POST /api/train/round` `{backend}` | `{job_id}`; progress arrives as events |
| `POST /api/stream/start` `{rate_per_min}` | Starts the simulated ticket stream |
| `POST /api/stream/stop` | Stops it |
| `POST /api/mode/offline` `{offline}` | Forces offline (teacher disabled, unsure tickets go to review) or back online |
| `GET /api/events` | Server-sent events: `prediction`, `train_progress`, `round_complete`, `mode` |

## Realtime

The store subscribes to `GET /api/events` (SSE). Events can be sent as `{type, data}` envelopes or as bare payloads with the SSE `event:` name giving the type. If the stream cannot connect, or drops, the app falls back to polling every **2 seconds** (`/api/tickets/recent`, `/api/health`, `/api/rounds`), keeps retrying SSE with backoff, and switches back when it succeeds. A banner under the header says when it is on polling. The store also refreshes summary, timeseries, review queue and health every 4 seconds as a safety net.

## Offline demo notes

- The page and all its assets are served by `npm start` on this machine. Fonts are the system stack; there are no web fonts, analytics or image CDNs.
- The browser talks only to `127.0.0.1:8000` (backend) and `localhost:3001` (this app), both loopback, so turning Wi-Fi off does not affect them.
- Load the page **once while online** before the demo so the snapshot cache below is populated.
- The backend's own offline mode (`POST /api/mode/offline`) is separate from your network: it makes the router skip the teacher, so unsure tickets go to the review queue. The **Offline** badge in the header shows that mode.

### Snapshot fallback

While the backend is reachable the store saves the latest good state to `localStorage` (key `understudy.snapshot.v1`, at most once every 10 seconds). If the app loads and the backend is unreachable (for example the tunnel is down), it shows the cached state with a **"Snapshot from HH:MM:SS"** banner and keeps retrying in the background; it returns to live data when the backend answers. With no cached snapshot and no backend you get a "Can't reach the backend" banner and empty states.

## Pages

| Route | What it is |
| --- | --- |
| `/` | Landing: the pitch, the problem, live numbers (share handled locally, cloud cost, cost avoided), the loop explained, links in |
| `/live` | Start and stop the ticket stream, watch routing as it happens, force offline, work the human review queue |
| `/training` | Run a training round and watch it progress from collect to train to evaluate to promote |
| `/results` | Base vs trained vs teacher: accuracy, speed, cost, per-category F1, confusion |

Shared code: `src/lib/` (types, API, events, store, snapshot, categories, format), `src/components/ui/` (primitives), `src/components/shell/` (nav, banners), `src/components/landing/`.

## Demo script

Short version (the full presenter checklist is in [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md)):

1. Open `/` and say what the three numbers mean.
2. Go to `/live` and **start the stream**.
3. **Watch the counters**: tickets arrive, most are answered locally, some go to the teacher.
4. Go to `/training` and **run a training round**; watch the stages and the new version being promoted.
5. Back on `/live`: the local share rises after the new version serves.
6. **Force offline** (and turn Wi-Fi off): unsure tickets now land in the **review queue**.
7. Open `/training` for the story of the rounds, then `/results` for the comparison.

## Deploying to Vercel

1. Import the repo in Vercel and set **Root Directory** to `frontend`. Leave the build and output settings at their defaults.
2. Set environment variables:
   - `NEXT_PUBLIC_API_URL` = your cloudflared tunnel URL (see below), `https://...trycloudflare.com`
   - `NEXT_PUBLIC_DATA_SOURCE` = `api` for the real backend, or `snapshot` for a public preview that shows only the bundled snapshot
3. Deploy.

Things to know:

- `NEXT_PUBLIC_` variables are compiled into the bundle. **After changing the tunnel URL you must redeploy.** Quick tunnels get a new URL on every run.
- An HTTPS page cannot call an `http://` backend (mixed content is blocked). cloudflared URLs are HTTPS, so use those. Do not point a Vercel deployment at `http://127.0.0.1:8000`.
- The backend's CORS settings must allow the Vercel origin (and `http://localhost:3001` for local runs).
- SSE works through cloudflared, but proxies sometimes buffer it. If events arrive in bursts or not at all, the 2-second polling fallback covers it automatically; the backend should also send `Cache-Control: no-cache` and `X-Accel-Buffering: no` on `/api/events`.
- A Vercel deployment cannot demo the Wi-Fi-off moment; for that use the local build.

## cloudflared tunnel

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8000
```

The quick tunnel prints a `https://<random>.trycloudflare.com` URL. Put it in `NEXT_PUBLIC_API_URL` and redeploy. The URL changes each time you restart the tunnel. For a stable URL, create a named tunnel with a domain you control (`cloudflared tunnel login`, `cloudflared tunnel create`, route DNS, then `cloudflared tunnel run`).

## Open WebUI side-by-side comparison

Open WebUI runs on http://127.0.0.1:3000 against `mlx_lm.server` on :8080, started by the repo-root `start.sh`. It is already running for the demo and **this frontend does not change it**.

If the backend serves both model versions (for example the base model and the trained adapter as separate model ids on the mlx server, or as two servers), you can compare them in Open WebUI:

1. Open http://127.0.0.1:3000 and pick a model in the selector at the top of a chat.
2. Click the **+** next to the model selector to add a second model.
3. Send one prompt; the chat shows both answers side by side.
4. Paste a ticket from `/live` to compare the base and trained models on the same text.

Whether the trained model appears in Open WebUI depends on the backend actually serving it there; if only the base model is listed, there is nothing to compare.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| "SNAPSHOT" badge when you expected live data | The backend is unreachable, or `NEXT_PUBLIC_DATA_SOURCE` is `snapshot`. Check `.env.local` and the backend, then rebuild. |
| "Can't reach the backend" banner | Backend not running on :8000, or `NEXT_PUBLIC_API_URL` is wrong. Check `curl http://127.0.0.1:8000/api/health`. |
| Changed `.env.local` but nothing changed | `NEXT_PUBLIC_` values are baked at build time. Rebuild (`npm run build`) or restart `npm run dev`. |
| Browser console shows a CORS error | Backend CORS does not allow this origin (`http://localhost:3001` or the Vercel URL). |
| Works locally, blocked on Vercel | Mixed content: the API URL is `http://`. Use the HTTPS cloudflared URL and redeploy. |
| Vercel page worked, then stopped | The quick tunnel restarted and got a new URL. Update `NEXT_PUBLIC_API_URL` and redeploy. |
| "Realtime stream unavailable, updating every 2 seconds" | SSE is blocked or buffered. Polling is covering it; the demo still works. Check the backend `/api/events` and tunnel buffering. |
| "Snapshot from HH:MM:SS" banner | The backend is unreachable and cached data is shown. Restore the backend or tunnel; it reconnects by itself. |
| Port 3001 already in use | Another process holds it. `npm start -- -p 3002` (and allow that origin in CORS). |
| Numbers do not move | The stream is not started. Press start on `/live`. |
| Blank or half-loaded page in dev | Stale `.next/`. Stop the server, delete `.next`, start again. |

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev -- -p 3001` | Development server |
| `npm run build` | Production build |
| `npm start -- -p 3001` | Serve the production build |
| `npm run lint` | ESLint |
