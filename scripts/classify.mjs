// Open-weights classification for the leaderboard scraper.
//
// Strategy (in order of confidence):
//   1. Per-model overrides — exact/prefix matches for known exceptions.
//   2. Curated creator lists — established orgs we already know are open/closed.
//   3. Hugging Face verification — for creators NOT covered above, ask HF whether
//      that creator publishes public model weights. This is where new/unknown
//      creators get resolved instead of being blindly defaulted.
//
// HF is used ONLY for the unknown bucket on purpose: the curated lists are
// authoritative for established creators, and we don't want a transient HF
// outage to flip a known-correct label. Anything HF can't confirm stays closed
// (conservative), and the reason is recorded so the data is auditable.

const HF_ORG_MAP = {
  alibaba: 'Qwen', deepseek: 'deepseek-ai', xiaomi: 'XiaomiMiMo',
  minimax: 'MiniMaxAI', kimi: 'moonshotai', nvidia: 'nvidia',
  zhipu: 'THUDM', 'z ai': 'THUDM', meta: 'meta-llama', mistral: 'mistralai',
  ibm: 'ibm-granite', stepfun: 'stepfun-ai', tencent: 'tencent',
  baidu: 'baidu', 'reka ai': 'RekaAI', sarvam: 'sarvamai',
  // Explicitly closed — never probe HF for these.
  google: null, openai: null, anthropic: null, xai: null,
  cohere: null, amazon: null, 'ai21 labs': null,
};

const KNOWN_OPEN_CREATORS = new Set([
  'alibaba', 'deepseek', 'xiaomi', 'minimax', 'kimi', 'nvidia', 'meta',
  'mistral', 'ibm', 'lg ai research', 'perplexity', 'upstage', 'liquid ai',
  'prime intellect', 'inclusionai', 'stepfun', 'tencent', 'baidu',
  'openai-open', 'zhipu', 'z ai', 'korea telecom', 'arcee ai',
  'motif technologies', 'swiss ai initiative', 'reka ai', 'cohere-open', 'sarvam',
]);

const KNOWN_CLOSED_CREATORS = new Set([
  'openai', 'anthropic', 'google', 'xai', 'amazon', 'cohere', 'ai21 labs',
  'minimax-closed', 'longcat',
]);

const MODEL_OVERRIDES = {
  'minimax-m3': true, 'minimax-m2.7': true, 'glm-5.1': true,
  'gpt-oss-120b (high)': true, 'gpt-oss-120b (low)': true,
  'gpt-oss-20b (high)': true, 'gpt-oss-20b (low)': true,
  'gemma 4 31b': true, 'gemma 4 26b a4b': true, 'gemma 4 e4b': true,
  'gemma 4 e2b': true, 'gemma 3 270m': true,
  'llama 4 scout': true, 'llama 4 maverick': true, 'llama 3.3 70b': true,
  'llama 3.1 405b': true, 'llama 3.2 90b (vision)': true, 'llama 3.2 11b (vision)': true,
  'command a': false, 'command a+': false,
  'granite 4.1 30b': true, 'granite 4.1 8b': true, 'granite 4.1 3b': true,
  'granite 4.0 h small': true, 'granite 4.0 micro': true, 'granite 4.0 350m': true,
  'granite 4.0 1b': true, 'granite 4.0 h 1b': true, 'granite 4.0 h 350m': true,
  'phi-4': true, 'phi-4 multimodal': true, 'phi-4 mini': true,
  'devstral 2': true, 'devstral small 2': true,
  'nova premier': false, 'nova 2.0 pro preview': false,
  'nova 2.0 lite': false, 'nova micro': false,
  'qwen3.7 max': true, 'qwen3.7 plus': true,
  'grok 4.3 (high)': false, 'grok 4.3 (medium)': false, 'grok 4.3 (non-reasoning)': false,
};

// Synchronous heuristic — returns true | false | null (null = not covered).
function heuristic(modelName, creatorName) {
  const ml = modelName.toLowerCase();
  const cl = creatorName.toLowerCase().trim();

  for (const [k, v] of Object.entries(MODEL_OVERRIDES)) {
    if (ml === k || ml.startsWith(k)) return { open: v, reason: 'override' };
  }
  if (KNOWN_CLOSED_CREATORS.has(cl)) return { open: false, reason: 'known-closed' };
  if (KNOWN_OPEN_CREATORS.has(cl)) return { open: true, reason: 'known-open' };
  for (const oc of KNOWN_OPEN_CREATORS) {
    if (cl.includes(oc) || oc.includes(cl)) return { open: true, reason: 'known-open~' };
  }
  for (const cc of KNOWN_CLOSED_CREATORS) {
    if (cl.includes(cc) || cc.includes(cl)) return { open: false, reason: 'known-closed~' };
  }
  return null; // unknown → resolve via HF
}

// Guess plausible HF org slugs for an unmapped creator name.
function slugCandidates(creator) {
  const base = creator.toLowerCase().trim();
  const compact = base.replace(/[^a-z0-9]+/g, '');
  const dashed = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [...new Set([compact, dashed, creator.trim().replace(/\s+/g, '')])].filter(Boolean);
}

async function hfOrgHasWeights(slug, fetchImpl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url = `https://huggingface.co/api/models?author=${encodeURIComponent(slug)}&limit=3&full=false`;
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'llm-leaderboard-bot/1.0 (+https://github.com/parthi2929/llm-leaderboard)' },
    });
    if (!res.ok) return false;
    const arr = await res.json();
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false; // network/abort → treat as unconfirmed
  } finally {
    clearTimeout(t);
  }
}

// Resolve open/closed for every model. Returns models as
// [model, creator, intel, price, open] and a small classification report.
export async function classifyModels(models, { fetchImpl = fetch } = {}) {
  const creatorCache = new Map(); // creator(lower) → boolean (HF result)
  const report = { override: 0, knownOpen: 0, knownClosed: 0, hfOpen: 0, hfClosedOrUnknown: 0 };
  const out = [];

  for (const [model, creator, intel, price] of models) {
    const h = heuristic(model, creator);
    let open;
    if (h) {
      open = h.open;
      if (h.reason.startsWith('override')) report.override++;
      else if (h.open) report.knownOpen++;
      else report.knownClosed++;
    } else {
      const cl = creator.toLowerCase().trim();
      if (creatorCache.has(cl)) {
        open = creatorCache.get(cl);
      } else {
        // Explicit null in HF_ORG_MAP means "known closed, don't probe".
        let resolved = false;
        if (HF_ORG_MAP[cl] === null) {
          resolved = false;
        } else {
          const slugs = HF_ORG_MAP[cl] ? [HF_ORG_MAP[cl]] : slugCandidates(creator);
          for (const slug of slugs) {
            if (await hfOrgHasWeights(slug, fetchImpl)) { resolved = true; break; }
          }
        }
        open = resolved;
        creatorCache.set(cl, open);
      }
      if (open) report.hfOpen++; else report.hfClosedOrUnknown++;
    }
    out.push([model, creator, intel, price, open]);
  }
  return { models: out, report };
}
