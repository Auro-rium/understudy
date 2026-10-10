# Understudy: demo frontend

The browser UI for **Understudy**, built by team e/acc for the Awign Hackathon (Open Theme).

Gig workers send support tickets in English (payment delays, deductions, KYC, app issues, task assignment and ratings, safety). A small local model classifies each ticket into a category and a priority, which decides the team. When it is unsure it asks a cloud teacher model. The teacher's answers become training data, and LoRA training rounds produce the next local version. A new version is promoted only if it beats the one already serving. Offline, unsure tickets go to a human review queue instead.

This app shows that loop and the results of it. **Every number on screen comes from the backend's real data**: live from the API when it is reachable, otherwise from an exported snapshot of that same data. There is no mock or demo data layer.

## What the real data says today

These figures come from the bundled export (`public/export/snapshot.json`), not from this README's imagination. Re-check them on `/results` after a sync.

- Models evaluated: `base`, `round_1`, `round_2`, `round_3`. Macro-F1 on the test set: 0.761, 0.695, 0.789, 0.919. Accuracy: 0.755, 0.730, 0.785, 0.920.
- `round_1` was **rejected** by the promotion gate (it scored below the base model). `round_2` and `round_3` were **promoted**.
- The rounds were trained locally on an Apple M5 16GB Mac, at a recorded cost of $0.
- The evaluation is **provisional**: the test labels are teacher-derived and not yet verified by people. The UI marks it with a Provisional badge.
- The snapshot contains **no live traffic** (`summary.total` is 0). So the live counters (share handled locally, cloud cost, cost avoided) are hidden or show an empty state until the backend has actually handled tickets. Do not quote them before then.

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

Then open http://localhost:3001. With no backend running you see the bundled snapshot (SNAPSHOT badge in the header). With the backend up on :8000 you see live data.

For development with hot reload:

```bash
npm run dev -- -p 3001
```

Use the production build (`npm start`) for the actual demo: it is faster and has no dev overlay.

## Environment variables

Set in `.env.local` (copy from `.env.example`). `NEXT_PUBLIC_*` values are **baked in at build time**, so rebuild (or restart `npm run dev`) after changing them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:8000` | Base URL of the FastAPI backend. On Vercel this is the cloudflared tunnel URL. |
| `NEXT_PUBLIC_DATA_SOURCE` | `api` | `api` = use the live backend, falling back to a saved snapshot when it is unreachable. `snapshot` = never call the API; show the bundled snapshot only. |

## Data source and fallback order

With `NEXT_PUBLIC_DATA_SOURCE=api` (the default), on load and then continuously:

1. **Live API.** `GET /api/snapshot` first; if that returns an HTTP error, the individual endpoints are fetched instead. While live, summary, timeseries, review queue and health refresh every 4 seconds, rounds and eval every fifth refresh, and events arrive over SSE. The latest good live state is cached in `localStorage` (key `understudy.snapshot.v2`, at most every 10 seconds).
2. **Saved snapshot.** If the API is unreachable (or two refreshes in a row fail), the app shows the **newer** of the `localStorage` cache and the bundled `/export/snapshot.json`, comparing their `generated_at`. A **SNAPSHOT** badge with the snapshot's time appears, a banner says the controls are disabled, and the start-stream, train, and offline controls reject.
3. **Retry.** While on a snapshot the store retries the API every 5 seconds and switches back to live by itself when it answers.
4. **Nothing at all.** No API, no cache, no bundled file: a "Can't reach the backend" banner and empty states.

With `NEXT_PUBLIC_DATA_SOURCE=snapshot` the app makes **zero API calls** and shows the bundled snapshot only (banner: "this copy is not connected to a backend").

### Refreshing the bundled snapshot

```bash
npm run sync:snapshot                        # copies exports/snapshot.json from the origin/backend branch
bash scripts/sync-snapshot.sh http://127.0.0.1:8000   # or: pull /api/snapshot from a running backend
```

The script refuses to overwrite the file if the source has no `generated_at`. It only writes `public/export/snapshot.json`; commit that file and redeploy to publish it.

"Stale" means: the bundled export is older than the backend's current state, for example a training round finished after the last sync, so the page shows fewer rounds than `/api/rounds` would. The snapshot's `generated_at` is shown next to the SNAPSHOT badge so the audience can see how old it is. Sync before every demo and before every Vercel deploy.

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
| `GET /api/rounds` | Training rounds with loss curve, eval, cost, hardware, `promoted` and `reason` |
| `GET /api/eval/compare` | Base vs trained rounds (and a teacher row if present): accuracy, macro F1, latency, cost per 1k, per-category F1, confusion matrices, `provisional` flag |
| `GET /api/snapshot` | Everything above in one payload plus `generated_at` |
| `POST /api/train/round` `{backend}` | `{job_id}`; progress arrives as events |
| `POST /api/stream/start` `{rate_per_min}` | Starts the simulated ticket stream |
| `POST /api/stream/stop` | Stops it |
| `POST /api/mode/offline` `{offline}` | Forces offline (teacher disabled, unsure tickets go to review) or back online |
| `GET /api/events` | Server-sent events: `prediction`, `train_progress`, `round_complete`, `mode` |

## Realtime

The store subscribes to `GET /api/events` (SSE). Events can be sent as `{type, data}` envelopes or as bare payloads with the SSE `event:` name giving the type. If the stream cannot connect, or drops, the app falls back to polling every **2 seconds** (`/api/tickets/recent`, `/api/health`, `/api/rounds`), keeps retrying SSE with backoff, and switches back when it succeeds. A banner under the header says when it is on polling.

## Pages

| Route | What it is |
| --- | --- |
| `/` | Landing: the pitch, the macro-F1 ladder (base through each round, promoted or rejected), headline numbers computed from the rounds, live-traffic numbers only once tickets exist |
| `/live` | Start and stop the ticket stream, watch routing as it happens, force offline, work the human review queue (needs the backend) |
| `/training` | The rounds so far; with the backend up, run a round and watch collect, train, evaluate, promote |
| `/results` | Base vs trained rounds: accuracy, speed, cost, per-category F1, confusion, provisional flag |

### Screenshots

Captured from the production build with no backend running, so they show the bundled snapshot (hence the SNAPSHOT badge), at 1920x1080 and 390x844. They are in `docs/screenshots/`.

| File | Shows |
| --- | --- |
| `landing.png` | Landing page |
| `live.png`, `mobile-live.png` | `/live` in the empty snapshot state (controls disabled with an explanation) |
| `training.png`, `training-rounds.png` | `/training`: macro-F1 across rounds, per-round cards with loss curves |
| `results-table.png` | `/results`: model comparison table with promoted and rejected rounds |
| `results-confusion.png` | `/results`: per-category F1 and the confusion heatmap |
| `mobile-results.png` | `/results` at phone width |

Shared code: `src/lib/` (types, API, events, store, snapshot, categories, format), `src/components/ui/` (primitives), `src/components/shell/` (nav, banners), `src/components/landing/`.

## Offline (Wi-Fi off) demo

- `npm start -- -p 3001` serves the page and all assets from this machine. Fonts are the system stack; there are no web fonts, analytics or image CDNs.
- The browser talks only to `127.0.0.1:8000` (backend) and `localhost:3001` (this app), both loopback, so turning Wi-Fi off does not affect them. Build with the default `NEXT_PUBLIC_API_URL`, not a tunnel URL, for this.
- The backend's own offline mode (`POST /api/mode/offline`, the **force offline** control on `/live`) is separate from your network: it makes the router skip the teacher, so unsure tickets go to the review queue. The **Offline** badge in the header shows that mode, and an amber banner says so.
- If the backend is not running, the Wi-Fi-off moment still works for browsing: the bundled snapshot is served from the same local server. Stream, train and force-offline need the backend.

## Deploying to Vercel

The project is `understudy`; production is https://understudy-lake.vercel.app.

1. Root Directory is `frontend`. Build and output settings stay at their defaults.
2. Environment variables:
   - **No tunnel yet:** set `NEXT_PUBLIC_DATA_SOURCE=snapshot`. The deploy shows the bundled snapshot, never calls an API, and says so in its banner. Run `npm run sync:snapshot` and commit the file first so the deploy has the latest rounds.
   - **With a tunnel:** set `NEXT_PUBLIC_API_URL` to the cloudflared `https://...trycloudflare.com` URL and `NEXT_PUBLIC_DATA_SOURCE=api`.
3. Redeploy. `NEXT_PUBLIC_*` values are compiled into the bundle, so **every change to them needs a new deploy**; a quick tunnel gets a new URL each time it restarts.

Things to know:

- An HTTPS page cannot call an `http://` backend (mixed content is blocked). cloudflared URLs are HTTPS. Never point a Vercel deployment at `http://127.0.0.1:8000`.
- The backend's CORS settings must allow the Vercel origin (`https://understudy-lake.vercel.app`, plus any preview URLs you use) and `http://localhost:3001` for local runs.
- If the tunnel is down the deployed page falls back to the cached or bundled snapshot with the SNAPSHOT badge, which is the honest state to show.
- SSE through a tunnel may be buffered; the 2-second polling fallback covers it. The backend should send `Cache-Control: no-cache` and `X-Accel-Buffering: no` on `/api/events`.
- A Vercel deployment cannot demo the Wi-Fi-off moment; use the local build.

## cloudflared tunnel

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8000
```

The quick tunnel prints a `https://<random>.trycloudflare.com` URL.

1. Check it: `curl https://<random>.trycloudflare.com/api/health`.
2. Set it as `NEXT_PUBLIC_API_URL` in Vercel (and `NEXT_PUBLIC_DATA_SOURCE=api`) and redeploy.
3. Make sure backend CORS allows the Vercel origin.

The URL changes every time you restart the tunnel, which means another env update and redeploy. For a stable URL, create a named tunnel with a domain you control (`cloudflared tunnel login`, `cloudflared tunnel create`, route DNS, then `cloudflared tunnel run`).

## Open WebUI side-by-side comparison

Open WebUI runs on http://127.0.0.1:3000 against `mlx_lm.server` on :8080, started by the repo-root `start.sh`. This is documentation only: **this frontend does not start, configure or change either of them.**

If the mlx server exposes both the base model and a trained round (as separate model ids or as two servers), you can compare them in Open WebUI:

1. Open http://127.0.0.1:3000 and pick a model in the selector at the top of a chat.
2. Click the **+** next to the model selector to add a second model.
3. Send one prompt; the chat shows both answers side by side.
4. Paste a ticket text to compare the base and a trained round on the same input.

If only one model is listed there, there is nothing to compare; use `/results` for the measured comparison instead.

## Known limits

- **Round markers need timestamps.** The share-over-time chart marks the moment a round was promoted by anchoring on the timeseries. Markers are created only for rounds that finish while the page is open, and only when the timeseries has points. The bundled snapshot has an empty timeseries and no round timestamps, so it shows no markers.
- **Live path is unproven here.** The bundled export contains no live traffic, so the SSE stream, stream/train controls and the tunnel path have not been exercised with real tickets by this build. Check them against the backend before relying on them.
- **Provisional evaluation.** Scores are on teacher-derived labels, not human-verified ones.
- **Live counters are empty** until the backend records tickets (`summary.total` greater than 0).

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| SNAPSHOT badge when you expected live data | The backend is unreachable, or `NEXT_PUBLIC_DATA_SOURCE` is `snapshot`. Check `.env.local` and the backend, then rebuild. It retries every 5 seconds. |
| "Can't reach the backend" banner | No backend and no snapshot at all. Check `curl http://127.0.0.1:8000/api/health` and that `public/export/snapshot.json` exists. |
| Changed `.env.local` but nothing changed | `NEXT_PUBLIC_` values are baked at build time. Rebuild (`npm run build`) or restart `npm run dev`. |
| Browser console shows a CORS error | Backend CORS does not allow this origin (`http://localhost:3001` or the Vercel URL). |
| Works locally, blocked on Vercel | Mixed content: the API URL is `http://`. Use the HTTPS cloudflared URL and redeploy. |
| Vercel page worked, then fell back to snapshot | The quick tunnel restarted and got a new URL. Update `NEXT_PUBLIC_API_URL` and redeploy. |
| "Realtime stream unavailable, updating every 2 seconds" | SSE is blocked or buffered. Polling is covering it. |
| Fewer rounds on screen than the backend has | The bundled snapshot is stale. Run `npm run sync:snapshot`, or start the backend. |
| Port 3001 already in use | `npm start -- -p 3002` (and allow that origin in CORS). |
| Blank or half-loaded page in dev | Stale `.next/`. Stop the server, delete `.next`, start again. |

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev -- -p 3001` | Development server |
| `npm run build` | Production build |
| `npm start -- -p 3001` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run sync:snapshot` | Refresh `public/export/snapshot.json` (see above) |

For the presenter's checklist and script see [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md).
