# Demo runbook

One page for the presenter. Read the numbers off the screen; do not quote figures that are not on it. Everything on screen is real exported backend data or live backend data, never invented.

## What is true today (real data)

- Macro-F1 on the test set: base **0.761**, round 1 **0.695** (rejected by the promotion gate), round 2 **0.789** (promoted), round 3 **0.919** (promoted). Accuracy: 0.755, 0.730, 0.785, 0.920.
- Rounds were trained locally on an Apple M5 16GB Mac, at a cost of **$0**.
- The evaluation is **provisional**: the test labels are teacher-derived and not yet verified by people.
- The bundled snapshot has **no live traffic**. Share handled locally, cloud cost and cost avoided are empty until the backend has handled tickets. Do not present them as results before that.

If the numbers on screen differ from these after a snapshot sync or a new round, trust the screen.

## Two modes

| Mode | When | What you can show |
| --- | --- | --- |
| **Snapshot** (default if the backend is down) | No backend needed; SNAPSHOT badge in the header | `/` ladder and headline numbers, `/training` rounds and loss curves, `/results` comparison. Not available: start stream, run round, force offline. |
| **Live** | Backend up on :8000, no SNAPSHOT badge | Everything above plus `/live` stream, running a training round, force offline and the review queue. |

## Pre-flight (10 minutes before)

- [ ] Refresh the bundled data: `npm run sync:snapshot` (or `bash scripts/sync-snapshot.sh http://127.0.0.1:8000` with the backend up), then `npm run build && npm start -- -p 3001`. Rebuild only after a data refresh or code change; the backend URL and demo key are runtime (`?api=`, `?key=`) and never need a rebuild.
- [ ] Live mode: open `http://localhost:3001/live?key=<demo key>` once so the key is saved (it disappears from the address bar). Header shows `API: 127.0.0.1:8000`. Confirm the model switch under "Model serving" lists base, round_1, round_2, round_3 with their F1.
- [ ] Offline proof: the app has no third-party requests (system fonts, no CDN or analytics), so `npm start` works with Wi-Fi off.
- [ ] Open http://localhost:3001. Decide the mode: **SNAPSHOT badge visible** means snapshot mode; **no badge** means live.
- [ ] Landing page shows the ladder (base, round 1 to 3) with a **Provisional** badge, and "2 of 3 rounds promoted". If it shows an empty state, the snapshot file is missing; fix before going on.
- [ ] Live mode only: `curl http://127.0.0.1:8000/api/health` returns a model version and `online`; no banner under the header ("updating every 2 seconds" or "saved snapshot" means something is wrong, see Recovery). Stream is **stopped**.
- [ ] Open WebUI (:3000) and mlx server (:8080) come from the repo's `start.sh`; leave them alone.
- [ ] Load every page once (`/`, `/live`, `/training`, `/results`).
- [ ] Browser: full screen, zoom so numbers read from the back, notifications off, one tab for the app, one for Open WebUI.
- [ ] Vercel backup (https://understudy-lake.vercel.app): open it and confirm it loads. Without a tunnel it is snapshot-only by design.
- [ ] Charger plugged in. Wi-Fi switch within reach.

## Script A: snapshot mode (no live traffic), 3 minutes

| Time | Screen | Do | Say |
| --- | --- | --- | --- |
| 0:00 | `/` | Point at the headline, then the ladder. | "Gig workers write to support in plain English. A small model on this laptop routes each ticket and asks a bigger cloud teacher only when it is unsure. The bars are how well it sorts tickets into the right category, on a held-out test set, round after round." |
| 0:40 | `/` | Point at the base bar, the hatched round 1 bar, then round 3. | "The base model scores 0.761. Round 1 got worse, 0.695, so the promotion gate rejected it and it never served a ticket. Round 2 improved to 0.789 and round 3 to 0.919. Every round was trained on this Mac, for zero dollars." |
| 1:10 | `/` | Point at the Provisional badge. | "One honest caveat: this evaluation is provisional. The test labels came from the teacher and have not been checked by people yet. So read 0.919 as a promising first result, not a final one." |
| 1:30 | `/` | Point at the "No live tickets recorded yet" note. | "We are not showing a share handled locally or cloud savings, because this data has no live traffic in it. Those counters fill in when tickets actually flow." |
| 1:50 | `/training` | Scroll the round cards. | "Each round trains a small LoRA adapter on teacher answers, tests it, and only promotes it if it beats the current model. Here is the loss curve and the reason for each decision." |
| 2:30 | `/results` | Show the comparison and per-category scores. | "Per category: where the model is strong and where it still confuses categories. This is where the next round should aim." |
| 3:00 | `/` | Credit. | "Team e/acc. Thank you." |

## Script B: live mode (backend up), 3 minutes

Same opening as Script A (0:00 to 1:10), then:

| Time | Screen | Do | Say |
| --- | --- | --- | --- |
| 1:10 | `/live` | Press **start stream**. | "Tickets are arriving now. Each gets a category, priority and team. Colour tells you who answered: blue is the local model, orange is the teacher." |
| 1:40 | `/live` | Point at one orange ticket and the counters. | "Here the model was not sure, so it asked the teacher. That answer becomes a training example." |
| 2:00 | `/training` | **Run training round** (only if the backend run is short enough; a full round can take many minutes, round 3 took about 33). Otherwise show the finished rounds. | "A round collects examples, trains, evaluates, and only then promotes." |
| 2:10 | `/live` | **Model switch** (optional, 10 s): under "Model serving" click `base`, wait for the loading line, then click `round_3`. | "Same laptop, same tickets: base scores 0.761, round 3 scores 0.919. Switching loads the other weights in a few seconds." Disabled while a training round runs. |
| 2:20 | `/live` | Turn **Wi-Fi off**, toggle **force offline**. | See below. |
| 2:45 | `/results` | Comparison; mention Provisional. | "Provisional, as I said: teacher-derived labels." |

Quote live numbers (share handled locally, cloud cost, cost avoided) only if they are on screen and `summary.total` is above zero.

## The Wi-Fi-off moment

1. Say what you are about to do before you do it.
2. Turn Wi-Fi off from the menu bar and let the audience see the icon.
3. **Snapshot mode:** reload nothing; click between `/`, `/training`, `/results`. Everything is served by `npm start` on this machine, which is the point: "this is all running here, nothing is fetched from the internet."
4. **Live mode:** toggle **force offline** on `/live`. This is the backend's offline mode, which disables the teacher: "When the model is unsure there is no teacher to ask, so those tickets go to a human review queue instead of getting a guess." An amber banner and the **Offline** badge appear; that is the mode, not a connection error. Show the review queue filling.
5. Turn force offline off and Wi-Fi back on when done.

This only works on the local build (`localhost:3001` against `127.0.0.1:8000`), not on Vercel.

## Going live when the backend comes up

1. Start the backend on :8000 and check `curl http://127.0.0.1:8000/api/health`.
2. The page retries every 5 seconds by itself; within a few seconds the SNAPSHOT badge disappears. No reload is needed.
3. For the public Vercel link: start `cloudflared tunnel --url http://127.0.0.1:8000` and open `https://understudy-lake.vercel.app/live?api=<printed https URL>&key=<demo key>`. **No rebuild, no redeploy.** The page saves the URL and key in the browser and removes them from the address bar; the header then shows `API: <tunnel host>`. If the tunnel restarts, open the page again with the new `?api=`. Make sure backend CORS allows the Vercel origin and the `X-Demo-Key` header. Until a URL is given the Vercel page is snapshot-only. (Needs the Vercel build to use the default `NEXT_PUBLIC_DATA_SOURCE=api`.)
   - The same works locally: `http://localhost:3001/live?key=<demo key>` (default API `http://127.0.0.1:8000`). Do not screenshot a URL that still contains `?key=`; after the first load it is gone from the bar.
4. Say plainly which mode you are in. If the SNAPSHOT badge is on screen, you are showing saved results.

## Recovery

| What happened | Do this |
| --- | --- |
| Page will not load | Check `npm start -- -p 3001` is still running. Restart it. |
| "Can't reach the backend" | Neither backend nor snapshot is available. Check `public/export/snapshot.json` exists; rebuild; start the backend. |
| SNAPSHOT badge when you wanted live | The backend is unreachable. Start it; the page reconnects within about 5 seconds. Meanwhile present snapshot mode honestly. |
| "Demo key missing or wrong - open the page with ?key=..." | Open `/live?key=<demo key>` again (the old key was wrong or never saved). Controls stay usable. |
| Model switch fails or is greyed out | Greyed: a training round is running, or the backend is not reachable. Error text under it is the backend's reason (409 round running, 500 load failure). `/api/health.model_version` is the truth. |
| Header says `API: 127.0.0.1:8000` but you want the tunnel | Open the page with `?api=<tunnel URL>`. `?api=` with no value forgets the saved URL. |
| Start, train or force-offline buttons do nothing | They are disabled on a snapshot. Wait for the backend or stay on the snapshot script. |
| "updating every 2 seconds" banner | SSE is down; polling covers it. Carry on. |
| Stream started but nothing moves | Press stop then start on `/live`. Check the backend log. |
| Training round freezes | Progress clears itself after about 30 seconds without events. Show the earlier rounds on `/training` and move on to `/results`. |
| Vercel backup shows older rounds | The bundled snapshot is stale. Run `npm run sync:snapshot`, commit, redeploy. |
| Someone asks about live savings | "There is no live traffic in this data yet, so we are not claiming a number." |

## After

- [ ] Turn force offline off, stop the stream, Wi-Fi on.
- [ ] Leave the app on `/` for questions; `/results` is the best page for Q&A.
