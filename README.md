# LLM Leaderboard

A static, single-page visualization of the [Artificial Analysis](https://artificialanalysis.ai/leaderboards/models)
models leaderboard (intelligence vs. cost per task, open vs. closed weights).

**Live page:** https://parthi2929.github.io/llm-leaderboard/

## How the data updates (and why it's safe)

The page reads a static `data.json` from its own origin. That file is refreshed
by a scheduled GitHub Action — never by the browser.

```
GitHub Action (on push to main, + cron twice daily)
  → fetch artificialanalysis.ai server-side (no CORS proxy)
  → parse the structured model payload (scripts/scrape.mjs)
  → classify open/closed weights  (scripts/classify.mjs)
        curated lists for known creators + Hugging Face lookup for unknown ones
  → read input modality from AA model pages (new models only; cached in data.json)
  → commit refreshed data.json IF it changed
        (row: model, creator, intel, costPerTaskUsd, open, multimodal)
  → stamp the commit SHA into index.html and deploy to Pages (Actions artifact)
index.html  → fetch ./data.json  (same origin, static)
```

The footer shows `build <short-sha> · <utc-time>` so you can confirm which commit
the live page was built from.

There is **no backend a visitor can call**, so no amount of page traffic can run
the Action or consume any quota:

- Triggers are limited to `schedule` + manual `workflow_dispatch`. No
  `push` / `pull_request` / `repository_dispatch`, so visitors and fork PRs
  can't start it.
- The workflow token has `contents: write` and nothing else.
- Third-party actions are pinned to full commit SHAs.
- Public repo → Action minutes are free; private → only the two daily cron runs
  count, a fixed and predictable number.
- If `data.json` is ever missing, the page falls back to an embedded snapshot so
  it never renders blank.

## Files

| Path | Purpose |
|------|---------|
| `index.html` | The whole app (canvas charts + UI), loads `./data.json`. |
| `data.json` | Scraped leaderboard data, committed by the Action. |
| `scripts/scrape.mjs` | Server-side scraper (Node 22, no dependencies). |
| `scripts/classify.mjs` | Open/closed classification (curated lists + Hugging Face). |
| `scripts/openweights.mjs` | AA payload parsing for open weights and input modalities. |
| `scripts/serve.mjs` | Zero-dependency static server for local preview. |
| `.github/workflows/deploy.yml` | Scheduled updater and Pages deployment. |

## Filters and saved views

The company control supports searching and selecting multiple companies. The
modality control distinguishes text-only models from models with image, speech,
or video input; `Unknown` covers rows whose source modality is unavailable.
All chart controls, including both filters, are stored in browser `localStorage`
and restored on the next visit.

## Preview the page locally

Opening `index.html` straight from disk (file://) can't fetch `./data.json` —
browsers block `fetch()` from file origins — so you'd only see the embedded
snapshot. Serve it over HTTP instead:

```bash
node scripts/serve.mjs   # → http://localhost:8080
```

## Run the scraper locally

```bash
node scripts/scrape.mjs   # rewrites data.json if the data changed
```

Data sourced from artificialanalysis.ai; please respect their Terms of Service.
The scrape runs at a low, fixed frequency.
