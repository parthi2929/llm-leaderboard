#!/usr/bin/env node
// Server-side scraper for the Artificial Analysis models leaderboard.
//
// Runs in GitHub Actions (no browser, no CORS proxy). Fetches the public page,
// parses its structured model payload, and writes data.json. It also resolves
// open/closed weights and text-only/multimodal inputs from AA's model payloads.
//
// Exit codes: 0 = wrote/updated data; 2 = scrape produced too few rows (kept
// the previous data.json untouched so a bad scrape never destroys good data).

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { classifyModels } from './classify.mjs';
import { extractOpenWeights, extractModalities } from './openweights.mjs';

const SOURCE = 'https://artificialanalysis.ai/leaderboards/models';
const OUT = new URL('../data.json', import.meta.url);
const MIN_ROWS = 30; // sanity floor; the structured payload normally has ~200

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      // Identify the bot honestly and look enough like a browser to get HTML.
      'User-Agent':
        'Mozilla/5.0 (compatible; llm-leaderboard-bot/1.0; +https://github.com/parthi2929/llm-leaderboard)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

function parse(authoritative) {
  const out = [];
  const seen = new Set();
  for (const r of authoritative.records || []) {
    if (!r.name || r.intel === null) continue;
    const key = r.name + '|' + r.creator;
    if (seen.has(key)) continue;
    seen.add(key);
    // AA's "Cost per Task USD": what one Intelligence Index task costs. It
    // depends on the tokens each effort level uses, so variants of one model
    // differ. A list token price would be the same for every variant.
    const price = r.costPerTask !== null && r.costPerTask > 0
      ? Number(r.costPerTask.toFixed(4))
      : null;
    out.push([r.name, r.creator, r.intel, price]);
  }
  return out;
}

// Modality lives on model detail pages rather than the leaderboard payload.
// Reuse values already committed in data.json and fetch only unresolved models.
// Detail pages include comparison records too, so each response can fill others.
async function addModalities(models, authoritative, previous) {
  const cache = new Map(
    previous.filter(m => typeof m[5] === 'boolean').map(m => [m[0] + '|' + m[1], m[5]])
  );
  const out = models.map(m => [...m, cache.get(m[0] + '|' + m[1]) ?? null]);
  const cached = out.filter(m => typeof m[5] === 'boolean').length;
  const groups = new Map();

  out.forEach((m, i) => {
    if (m[5] !== null) return;
    const slug = authoritative.get(m[0])?.slug;
    if (!slug) return;
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push(i);
  });

  const queue = [...groups];
  let cursor = 0, fetched = 0, failed = 0;
  const resolve = details => {
    out.forEach((m, i) => {
      if (m[5] !== null) return;
      const slug = authoritative.get(m[0])?.slug;
      const d = details.get(m[0]) || (slug && details.get(slug));
      if (d) m[5] = d.multimodal;
    });
  };

  async function worker() {
    while (cursor < queue.length) {
      const [slug, indexes] = queue[cursor++];
      if (indexes.every(i => out[i][5] !== null)) continue;
      try {
        const html = await fetchPage(new URL('/models/' + encodeURIComponent(slug), SOURCE).href);
        fetched++;
        resolve(extractModalities(html));
      } catch (e) {
        failed++;
        console.warn(`Modality fetch failed for ${slug}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  return {
    models: out,
    report: { cached, fetched, failed, unknown: out.filter(m => m[5] === null).length },
  };
}

async function main() {
  const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')).models || [] : [];
  const html = await fetchPage(SOURCE);
  const authoritative = extractOpenWeights(html);
  const parsed = parse(authoritative);
  const unpriced = parsed.filter((m) => m[3] === null).length;
  console.log(`Parsed ${parsed.length} models (${unpriced} with no published price).`);

  if (parsed.length < MIN_ROWS) {
    console.error(
      `Refusing to write: only ${parsed.length} rows (< ${MIN_ROWS}). ` +
        'Keeping previous data.json. Page layout may have changed.'
    );
    process.exit(2);
  }

  // AA ships per-model metadata in its structured payload. Use the same records
  // for open weights, creator, pricing and the detail-page slug.
  const covered = parsed.filter((m) => authoritative.has(m[0])).length;
  console.log(
    `Open-weights payload: ${authoritative.recordCount || 0} records, ` +
      `covering ${covered}/${parsed.length} scraped models.`
  );
  if (!authoritative.size) {
    console.warn(
      'WARNING: no open-weights payload found — AA may have changed their build. ' +
        'Falling back to the curated creator lists for every model.'
    );
  }

  // Resolve open/closed (AA payload, then curated lists + Hugging Face).
  const { models, report } = await classifyModels(parsed, { authoritative });
  console.log(
    `Classified: ${report.aa} from AA, ${report.override} override, ` +
      `${report.knownOpen} known-open, ${report.knownClosed} known-closed, ` +
      `${report.hfOpen} HF-open, ${report.hfClosedOrUnknown} HF-closed/unknown.`
  );

  const modality = await addModalities(models, authoritative, previous);
  console.log(
    `Modalities: ${modality.report.cached} cached, ` +
      `${models.length - modality.report.cached - modality.report.unknown} resolved, ` +
      `${modality.report.unknown} unknown; ${modality.report.fetched} detail pages fetched` +
      (modality.report.failed ? `, ${modality.report.failed} failed.` : '.')
  );

  {
    const payload = {
      source: SOURCE,
      updated: new Date().toISOString(),
      count: modality.models.length,
      // [model, creator, intelligenceIndex, costPerTaskUsd|null, openWeights, multimodal|null]
      models: modality.models,
    };
    const json = JSON.stringify(payload, null, 0) + '\n';

    // Skip the write if only the timestamp would change, so the workflow's
    // "commit if changed" check stays meaningful.
    if (existsSync(OUT)) {
      const same = JSON.stringify(previous) === JSON.stringify(modality.models);
      if (same) {
        console.log('No model changes since last run; leaving data.json as is.');
        return;
      }
    }

    writeFileSync(OUT, json);
    console.log(`Wrote ${OUT.pathname} (${modality.models.length} models).`);
  }
}

main().catch((err) => {
  console.error('Scrape failed:', err.message);
  process.exit(1);
});
