# Connecting the backend to the frontend

Brief for the backend agent. Everything here is derived from the frontend code
(`src/lib/api.ts`, `events.ts`, `snapshot.ts`, `types.ts`), so it is what the browser
actually sends and expects. If the backend and this doc disagree, the code in `src/lib/` wins.

## 1. How the frontend talks to you

- The frontend is a static Next.js app. **All requests are made by the browser**, not by a Next server. There is no proxy, so **CORS must be correct**.
- Base URL comes from `NEXT_PUBLIC_API_URL` (default `http://127.0.0.1:8000`, trailing slash stripped). It is baked in at build time.
- `NEXT_PUBLIC_DATA_SOURCE=api` (default) calls the backend. `snapshot` makes zero API calls and only shows the bundled export.
- Every request has a 4 s timeout. Anything slower counts as "unreachable".
- Every response is normalised leniently (`src/lib/snapshot.ts`): missing keys get neutral defaults and nothing throws. Still send the documented shapes.

### Required: CORS

Browsers on `http://localhost:3001` (local) and `https://understudy-lake.vercel.app` (Vercel) call the API cross-origin. Needed:

- `Access-Control-Allow-Origin` for those origins (or `*`; no credentials are used).
- `Access-Control-Allow-Methods: GET, POST, OPTIONS` and `Access-Control-Allow-Headers: Content-Type`. POST bodies are JSON, so a preflight happens.
- The SSE endpoint (`/api/events`) must also carry the CORS headers. `EventSource` is subject to CORS.

FastAPI: `CORSMiddleware(allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])` is enough for the demo.

### Vercel needs a public HTTPS URL

A page served from Vercel (HTTPS) cannot reliably call `http://127.0.0.1:8000` on the presenter's Mac. Expose the backend with a tunnel, then rebuild the frontend with that URL:

```bash
cloudflared tunnel --url http://127.0.0.1:8000     # prints https://<random>.trycloudflare.com
# in frontend/: set NEXT_PUBLIC_API_URL to that URL, then redeploy (it is baked at build time)
vercel deploy --prod --build-env NEXT_PUBLIC_API_URL=https://<random>.trycloudflare.com
```

Local demo (Wi-Fi off) needs no tunnel: `npm run build && npm start -- -p 3001` with the default `http://127.0.0.1:8000`.

## 2. Endpoints the frontend calls

| Method + path | Used for | Response / body |
|---|---|---|
| `GET /api/snapshot` | First load and the offline fallback. Preferred: one call gives the whole page. | `Snapshot` (below). If it returns an HTTP error, the frontend falls back to the 7 calls below. |
| `GET /api/health` | status, current model, mode | `{status, model_version, mode: "online"\|"offline"}` |
| `GET /api/metrics/summary` | big counters | `Summary` |
| `GET /api/metrics/timeseries` | share and cost charts | `TimePoint[]` |
| `GET /api/tickets/recent?limit=N` | feed (N up to 50) and the polling fallback | `Ticket[]`, **newest first** |
| `GET /api/review_queue` | review drawer | `ReviewItem[]` |
| `GET /api/rounds` | /training cards, loss curves | `Round[]` |
| `GET /api/eval/compare` | /results | `EvalCompare` |
| `POST /api/classify` `{text}` | single classify | `ClassifyResult` |
| `POST /api/train/round` `{backend: "mlx_local"\|"aws"\|"modal"}` | "Run training round" button (sends `mlx_local`) | `{job_id}`; progress then arrives over SSE |
| `POST /api/stream/start` `{rate_per_min}` | start simulated traffic | any 2xx, body ignored |
| `POST /api/stream/stop` | stop it | any 2xx |
| `POST /api/mode/offline` `{offline: boolean}` | force-offline toggle | any 2xx; mode must then show in `/api/health` and as a `mode` event |
| `GET /api/events` | SSE | see section 3 |

### Payload shapes (all from `src/lib/types.ts`)

```ts
Ticket        { id: number, text, created_at: ISO, category: "A".."H", category_name: "payment_delay"...,
                priority: "P1".."P4", team, source: "local"|"teacher"|"review",
                confidence: number|null, latency_ms, cost_usd, model_version }
Summary       { total, local_share, teacher_share, review_share /* 0..1 */,
                cost_usd_total, cost_avoided_usd, model_version, mode }
TimePoint     { t: ISO, local_share, cost_cumulative, cost_cloud_only_cumulative }
ReviewItem    { id: number, text, created_at }
Round         { round: 1.., model_version: "round_N", examples, loss: {step, loss}[], wall_time_s,
                hardware, cost_usd, promoted: boolean, reason: string,
                eval: {category_acc, category_macro_f1, priority_acc} }
EvalCompare   { provisional: boolean,
                models: {name, category_acc, category_macro_f1, priority_acc, latency_ms, cost_per_1k}[],
                router: same-as-model | {} | null,
                per_category_f1: {[model]: {A..H: number}},
                confusion: {[model]: number[8][8]} /* rows = true class, cols = predicted, A..H order */ }
Snapshot      { generated_at: ISO, health, summary, timeseries, tickets, review_queue, rounds, eval_compare }
```

Rules that matter:

- **Category is always the letter** (`A`..`H`). The frontend maps it to a name (`src/lib/categories.ts`: A payment_delay, B payment_dispute, C onboarding_kyc, D task_assignment, E app_technical, F task_submission, G account_status, H other). Do not send names in `category`. If `/api/tickets/recent` returns raw DB rows without `category_name` or `team`, the frontend fills them in.
- `per_category_f1` and `confusion` are keyed by **model name** then **letter**; the confusion matrix is 8x8 in A..H order.
- `models[].name` is `base`, `round_1`, `round_2`... Nothing hard-codes version names. A `teacher` row is optional; `router: {}` or null means "none".
- `provisional: true` makes the UI say test labels are teacher-derived and not human-verified. Set it to `false` only when a human-verified test set exists. The UI then says "Test set: N human-labelled tickets".
- `confidence` may be null. Priorities are `P1`..`P4`.
- `Round.loss` may be `[]` (the UI shows "No loss curve was recorded"). `promoted` plus `reason` is shown verbatim, e.g. `"macro-F1 improved 0.761 -> 0.789"`.
- **The serving model is `health.model_version`.** It must be the latest promoted round (e.g. `round_3`), not `base`. The committed export has `base` there; the frontend works around it only for saved snapshots (it picks the latest promoted round). On the live API, the frontend trusts your `/api/health`.
- `rounds` carries no timestamps, so past rounds cannot be marked on the timeseries. A round marker only appears when a `round_complete` event arrives and the timeseries is non-empty.

## 3. SSE: `GET /api/events`

The frontend opens `new EventSource(API_URL + "/api/events")`. On error it falls back to polling every 2 s (`/api/tickets/recent?limit=30`, `/api/health`, `/api/rounds`) and retries SSE with backoff (1 s up to 15 s).

Two framings are accepted per message:

1. `data: {"type": "...", "data": {...}}` (envelope, default `message` event), or
2. `event: <type>` with `data: {...}` as the bare payload.

Event types:

| type | `data` | Effect in the UI |
|---|---|---|
| `prediction` | a `Ticket` | feed row slides in, counters bump |
| `train_progress` | `{job_id, round, stage: "collect"\|"train"\|"evaluate"\|"promote", progress: 0..1, step?, total_steps?, loss?, message?}` | progress bar, loop diagram stage glow, live loss curve |
| `round_complete` | `{job_id, round: Round, previous_model_version}`. A bare `Round` is also accepted. | round banner (promoted or blocked), model chip flips |
| `mode` | `{mode: "online"\|"offline"}` | header badge and banner |
| `train_progress` with `error` | same shape plus `error: "<message>"` | a failed round shows inline in the training UI. There is no separate `round_failed` event type; unknown types are ignored. |

Send an initial comment or event soon after connect so `onopen` fires, and `Cache-Control: no-cache`, `Content-Type: text/event-stream`. Disable proxy buffering. Cloudflared passes SSE through.

## 4. Behaviour the UI expects

- **Offline mode:** after `POST /api/mode/offline {offline:true}`, teacher-bound tickets must not call the cloud. They get `source: "review"` and appear in `/api/review_queue`. `Summary.mode` and `Health.mode` must be `"offline"`.
- **Stream:** `POST /api/stream/start {rate_per_min}` should begin classifying sample tickets and emitting `prediction` events (one per ticket) until `/api/stream/stop`.
- **Training:** `POST /api/train/round` returns `{job_id}` immediately, then emits `train_progress` through the four stages and ends with `round_complete`. After a promoted round, `/api/health` and `/api/metrics/summary` must report the new `model_version`.
- **Counters** refresh from `/api/metrics/summary` every 4 s while live, and also bump optimistically on `prediction` events.
- **Disconnect:** after 2 failed refreshes (about 8 s) the UI switches to the newest of {localStorage cache, bundled `/export/snapshot.json`}, shows "SNAPSHOT" with its time, disables controls, and retries the API every 5 s. It recovers by itself when you are back.

## 5. The bundled export (the "snapshot" the UI shows with no backend)

- File: `frontend/public/export/snapshot.json`. It is a copy of `exports/snapshot.json` on the `backend` branch (same shape as `GET /api/snapshot`).
- Refresh: `npm run sync:snapshot` in `frontend/` (reads `git show origin/backend:exports/snapshot.json`, or pass a URL). Then commit and redeploy.
- **Regenerate and commit `exports/snapshot.json` on the `backend` branch after each training round**, otherwise the Vercel and Wi-Fi-off views go stale. It must include `generated_at`, or the sync script refuses it.
- Current content: rounds 1-3 (macro-F1 base 0.761, round_1 0.695 rejected, round_2 0.789, round_3 0.919), `provisional: true`, and **no live traffic** (summary zeros, `tickets`, `timeseries`, `review_queue` empty). If you can export a snapshot that includes real streamed tickets and a timeseries, the /live page fills in with them.

## 6. Smoke test checklist

```bash
B=http://127.0.0.1:8000
curl -s $B/api/health
curl -s $B/api/snapshot | head -c 400
curl -s -i -X OPTIONS $B/api/train/round -H 'Origin: http://localhost:3001' \
  -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' | head   # expect 200 + Allow-Origin
curl -s -N -H 'Origin: http://localhost:3001' $B/api/events | head -5                                  # expect text/event-stream
curl -s -X POST $B/api/stream/start -H 'content-type: application/json' -d '{"rate_per_min":30}'
curl -s "$B/api/tickets/recent?limit=3"                                                                  # newest first, category letters
curl -s -X POST $B/api/mode/offline -H 'content-type: application/json' -d '{"offline":true}'
```

Then run the frontend (`npm run build && npm start -- -p 3001`, open `http://localhost:3001/live`). Expected: no "SNAPSHOT" badge, controls enabled, counters and feed moving, force-offline flips the badge.

Common failures:

| Symptom | Cause |
|---|---|
| Stays on SNAPSHOT although the API is up | CORS missing, or `/api/snapshot` is returning errors. Check the browser console and network tab. |
| Controls disabled | The frontend counts the backend as unreachable (timeout over 4 s, CORS, wrong `NEXT_PUBLIC_API_URL`). Rebuild after changing it. |
| Feed updates only every 2 s | SSE is failing and polling took over. Check headers and proxy buffering. |
| Everything shows the old model | `health.model_version` is stale, or the snapshot was not regenerated. |
| Vercel page cannot reach the API | Using `127.0.0.1` instead of the tunnel URL, or the tunnel URL changed (it is baked at build time). |
