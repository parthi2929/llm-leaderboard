// Authoritative open-weights data, read from the leaderboard page itself.
//
// Artificial Analysis renders the table from a per-model payload it also ships
// to the browser as Next.js RSC flight data: a run of
// `self.__next_f.push([1,"<json-escaped chunk>"])` calls whose decoded string
// literals concatenate into one stream. Each model record in that stream carries
// isOpenWeights, licenseName and huggingfaceUrl — the same fields AA uses to
// answer "which models are open weights" on the page.
//
// Reading it replaces guessing from the creator name. A creator like Meta,
// Cohere, Google or AI21 ships both open and closed models, so any creator-level
// rule mislabels one side of their line-up.
//
// This is a best-effort parser over someone else's build output. Every failure
// mode returns fewer entries rather than wrong ones, and the caller falls back
// to the curated lists for anything missing.

const PUSH = 'self.__next_f.push([1,';

// Concatenate the decoded flight chunks back into one stream.
function rebuildFlight(html) {
  let out = '';
  let at = 0;
  for (;;) {
    const i = html.indexOf(PUSH, at);
    if (i < 0) break;
    const q = html.indexOf('"', i + PUSH.length);
    if (q < 0) break;
    let j = q + 1;
    while (j < html.length) {
      const c = html[j];
      if (c === '\\') { j += 2; continue; }   // escaped char — skip the pair
      if (c === '"') break;                   // unescaped quote ends the literal
      j++;
    }
    try {
      out += JSON.parse(html.slice(q, j + 1));
    } catch {
      // A chunk that won't decode costs us the models inside it, nothing more.
    }
    at = j + 1;
  }
  return out;
}

// Given an index inside an object, return that object's full JSON text by
// walking out to its braces. String literals are skipped so a brace inside a
// license name or URL cannot unbalance the scan.
function objectAround(s, idx) {
  let depth = 0;
  let start = -1;
  for (let i = idx; i >= 0; i--) {
    const c = s[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start < 0) return null;

  depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// Build a lookup keyed by the names the table can show. AA renders shortName in
// the leaderboard ("Claude Opus 5 (max)") while the record's name is the long
// form ("Claude Opus 5 (Adaptive Reasoning, Max Effort)"), so index both.
// shortName wins a collision because that is what the table renders.
export function extractOpenWeights(html) {
  const flight = rebuildFlight(html);
  const map = new Map();
  if (!flight) return map;

  let at = 0;
  let records = 0;
  for (;;) {
    const i = flight.indexOf('"isOpenWeights"', at);
    if (i < 0) break;
    at = i + 15;
    const raw = objectAround(flight, i);
    if (!raw) continue;

    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof r.isOpenWeights !== 'boolean') continue;

    records++;
    const entry = {
      open: r.isOpenWeights,
      license: r.licenseName || null,
      hf: r.huggingfaceUrl || null,
    };
    if (r.name && !map.has(r.name)) map.set(r.name, entry);
    if (r.shortName) map.set(r.shortName, entry);   // table name — always authoritative
  }

  map.recordCount = records;
  return map;
}
