# Demo runbook

One page for the presenter. Read the numbers off the screen; do not quote figures that are not on it.

## Pre-flight (10 minutes before)

- [ ] Backend up on :8000: `curl http://127.0.0.1:8000/api/health` returns a model version and `online`.
- [ ] `start.sh` stack up: mlx server on :8080, Open WebUI on :3000 (leave it alone).
- [ ] Frontend built with the **real backend**: `NEXT_PUBLIC_MOCK=0` in `.env.local`, then `npm run build && npm start -- -p 3001`.
- [ ] Open http://localhost:3001. **No "MOCK DATA" badge** in the header (unless you are deliberately demoing the mock).
- [ ] No banner under the header. If you see "updating every 2 seconds" or "Snapshot from ...", fix that first (see Recovery).
- [ ] Load every page once while online (`/`, `/live`, `/training`, `/results`) so the snapshot cache is filled.
- [ ] Browser: full screen, zoom so the numbers are readable from the back, notifications off, one tab for the app, one for Open WebUI.
- [ ] Mode shows **Online**. Stream is **stopped**. Review queue is understood (empty or not, know which).
- [ ] If showing the Vercel link as a backup: open it, confirm it loads, note that it needs the tunnel to be up.
- [ ] Charger plugged in. Wi-Fi switch within reach.

## The 3-minute script

| Time | Screen | Do | Say |
| --- | --- | --- | --- |
| 0:00 | `/` | Point at the headline and the three numbers. | "Gig workers write to support in plain English. Sending every ticket to a big cloud model costs money and needs internet. Our small model runs here on this laptop and asks the cloud teacher only when it is unsure. These three numbers are the whole story: how much we handle locally, what we paid the cloud, what we avoided." |
| 0:30 | `/live` | Press **start stream**. | "Tickets are arriving now. Each one gets a category, a priority and a team. The colour tells you who answered: blue is the local model, orange is the teacher." |
| 1:00 | `/live` | Watch the counters and the feed; point at one orange ticket. | "Here the local model was not sure, so it asked the teacher. That answer is now a training example." |
| 1:20 | `/training` | Press **run training round**. Let the stages advance. | "Those teacher answers become a LoRA training round on this machine. It collects, trains, evaluates, and only promotes the new version if it passes the check." |
| 1:50 | `/live` | Back to the feed after promotion; point at the version chip and the local share. | "New version is serving. Watch the share handled locally: the model needs the teacher less." |
| 2:10 | `/live` | Turn **Wi-Fi off** (see below), then toggle **force offline**. | "Wi-Fi is off. Nothing here needs the internet. When the model is unsure there is no teacher to ask, so those tickets go to a human review queue instead of getting a guess." |
| 2:30 | `/live` | Show the review queue filling. | "A person picks these up. Nothing is silently wrong." |
| 2:45 | `/results` | Show the comparison, mention if it is marked provisional. | "Base model, trained model and teacher side by side on accuracy, speed and cost. The evaluation set is small, so we label it provisional." |
| 3:00 | `/` | Credit. | "Team e/acc. Thank you." |

## The Wi-Fi-off moment

1. Say what you are about to do before you do it.
2. Turn Wi-Fi off from the menu bar and let the audience see the icon.
3. Toggle **force offline** on `/live` (this is the backend's offline mode, which disables the teacher).
4. The app should keep running: the page, the API and SSE are all on this machine. An amber banner ("Offline mode: uncertain tickets go to the human review queue") appears under the header and the badge flips to **Offline**; that is the backend's offline mode, not a connection error. A grey polling banner would be the only connection warning to expect.
5. When done, turn force offline off and Wi-Fi back on.

Open WebUI (:3000) also keeps working offline; use it for the base vs trained side-by-side only if the backend serves both models there (see README).

## Recovery

| What happened | Do this |
| --- | --- |
| Page will not load | Check `npm start -- -p 3001` is still running in its terminal. Restart it. |
| "Can't reach the backend" | Start or restart the backend on :8000; the page reconnects by itself within a few seconds. Do not reload if it already shows a snapshot. |
| "Snapshot from HH:MM:SS" banner | The backend is unreachable and you are looking at cached numbers. Say so honestly, restore the backend, wait for the banner to clear. |
| "updating every 2 seconds" banner | SSE is down; polling covers it. The demo still works, only a little less instant. Carry on. |
| Stream started but nothing moves | Press stop then start on `/live`. Check the backend log. |
| Training round never finishes or progress freezes | The progress indicator clears itself after about 30 seconds without events. Check the backend log. Show the earlier rounds on `/training` and move on to `/results`. |
| Vercel backup shows a stale or empty state | The tunnel URL changed or the tunnel is down. Use the local build on :3001 instead. |
| Everything is broken | Rebuild with `NEXT_PUBLIC_MOCK=1` and present with the **MOCK DATA** badge visible, saying clearly that the numbers are sample data. |

## After

- [ ] Turn force offline off, stop the stream, Wi-Fi on.
- [ ] Leave the app on `/` for questions; `/results` is the best page for Q&A.
