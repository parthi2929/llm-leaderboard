# LLM Leaderboard

A static, single-page visualization of the [Artificial Analysis](https://artificialanalysis.ai/leaderboards/models)
models leaderboard (intelligence vs. blended price, open vs. closed weights).

**Live page:** https://parthi2929.github.io/llm-leaderboard/

## How the data updates (and why it's safe)

The page reads a static `data.json` from its own origin. That file is refreshed
by a scheduled GitHub Action — never by the browser.

```
GitHub Action (on push to main, + cron twice daily)
  → fetch artificialanalysis.ai server-side (no CORS proxy)
  → parse the leaderboard table   (scripts/scrape.mjs)
  → classify open/closed weights  (scripts/classify.mjs)
        curated lists for known creators + Hugging Face lookup for unknown ones
  → commit refreshed data.json IF it changed   (row: model, creator, intel, price, open)
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
| `.github/workflows/update-leaderboard.yml` | Scheduled updater. |

## Run the scraper locally

```bash
node scripts/scrape.mjs   # rewrites data.json if the data changed
```

Data sourced from artificialanalysis.ai; please respect their Terms of Service.
The scrape runs at a low, fixed frequency.
