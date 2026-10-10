# Explainer page

A single static page (`index.html`, no build step) that explains Understudy: intent, problem, solution, architecture and results. Live at https://understudy-explainer.vercel.app.

The demo video is not stored here (it is committed once at `docs/media/demo.mp4`). To deploy:

```bash
cp docs/media/demo.mp4 docs/explainer/demo.mp4     # git-ignored copy the page loads
cd docs/explainer && vercel deploy --prod --yes --name understudy-explainer
```
