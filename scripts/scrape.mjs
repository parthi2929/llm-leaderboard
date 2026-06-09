#!/usr/bin/env node
// Server-side scraper for the Artificial Analysis models leaderboard.
//
// Runs in GitHub Actions (no browser, no CORS proxy). Fetches the public page,
// parses the server-rendered table, and writes data.json. Open/closed weight
// classification is left to the client (index.html) so this stays minimal.
//
// Exit codes: 0 = wrote/updated data; 2 = scrape produced too few rows (kept
// the previous data.json untouched so a bad scrape never destroys good data).

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { classifyModels } from './classify.mjs';

const SOURCE = 'https://artificialanalysis.ai/leaderboards/models';
const OUT = new URL('../data.json', import.meta.url);
const MIN_ROWS = 30; // sanity floor; the page normally has ~200

// Column indices within each <tr>, matching the page's table layout:
// 0=Model  1=Context  2=Creator  3=Intelligence  4=Blended price
const COL = { model: 0, creator: 2, intel: 3, price: 4 };

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

function cellText(tdHtml) {
  return decodeEntities(tdHtml.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

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

function parse(html) {
  const table = (html.match(/<table[\s\S]*?<\/table>/) || [''])[0];
  if (!table) throw new Error('no <table> found in page');

  const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((m) => m[0]);
  const out = [];
  const seen = new Set();

  for (const row of rows) {
    const cells = [...row.matchAll(/<td\b[\s\S]*?<\/td>/g)].map((m) => cellText(m[0]));
    if (cells.length < 5) continue; // header / non-data rows

    const model = (cells[COL.model] || '').split('\n')[0].trim();
    const creator = (cells[COL.creator] || '').split('\n')[0].trim() || 'Unknown';
    const intel = parseFloat(cells[COL.intel]);
    const price = parseFloat((cells[COL.price] || '').replace(/[$,]/g, ''));

    if (!model || isNaN(intel) || isNaN(price) || price < 0) continue;
    const key = model + '|' + creator;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([model, creator, intel, price]);
  }
  return out;
}

async function main() {
  const html = await fetchPage(SOURCE);
  const parsed = parse(html);
  console.log(`Parsed ${parsed.length} models.`);

  if (parsed.length < MIN_ROWS) {
    console.error(
      `Refusing to write: only ${parsed.length} rows (< ${MIN_ROWS}). ` +
        'Keeping previous data.json. Page layout may have changed.'
    );
    process.exit(2);
  }

  // Resolve open/closed (curated lists + Hugging Face for unknown creators).
  const { models, report } = await classifyModels(parsed);
  console.log(
    `Classified: ${report.override} override, ${report.knownOpen} known-open, ` +
      `${report.knownClosed} known-closed, ${report.hfOpen} HF-open, ` +
      `${report.hfClosedOrUnknown} HF-closed/unknown.`
  );

  {
    const payload = {
      source: SOURCE,
      updated: new Date().toISOString(),
      count: models.length,
      // [model, creator, intelligenceIndex, blendedUsdPer1M, openWeights]
      models,
    };
    const json = JSON.stringify(payload, null, 0) + '\n';

    // Skip the write if only the timestamp would change, so the workflow's
    // "commit if changed" check stays meaningful.
    if (existsSync(OUT)) {
      const prev = JSON.parse(readFileSync(OUT, 'utf8'));
      const same = JSON.stringify(prev.models) === JSON.stringify(models);
      if (same) {
        console.log('No model changes since last run; leaving data.json as is.');
        return;
      }
    }

    writeFileSync(OUT, json);
    console.log(`Wrote ${OUT.pathname} (${models.length} models).`);
  }
}

main().catch((err) => {
  console.error('Scrape failed:', err.message);
  process.exit(1);
});
