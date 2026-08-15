/**
 * Serverless rewrite endpoint (Vercel / Netlify Node runtime).
 *
 * Holds YOUR provider API key server-side so visitors get AI rewrites without
 * needing a key of their own. Works with Anthropic, OpenAI, Google Gemini, or
 * any OpenAI-compatible endpoint. The app is fine without this file deployed —
 * it falls back to the offline coach and the copy-into-a-chat route.
 *
 * Required env vars: AI_API_KEY
 *                    AI_PROVIDER   anthropic | openai | gemini | compatible
 * Optional env vars: AI_MODEL      (sensible default per provider)
 *                    AI_BASE_URL   required for "compatible" (Groq, Mistral,
 *                                  DeepSeek, xAI, OpenRouter, Together, Ollama…)
 *                    ALLOWED_ORIGIN        (default *, set to your domain)
 *                    DAILY_REQUEST_BUDGET  (default 2000, a crude global cap)
 *
 * NOTE ON LIMITS: serverless instances are ephemeral and not shared, so the
 * counters below are best-effort only — they blunt casual abuse, they do not
 * enforce a hard spend cap. For real protection put a budget limit on the
 * provider key itself and move these counters into Redis/KV.
 */

/* Provider is chosen with AI_PROVIDER: anthropic | openai | gemini | compatible.
   "compatible" means any OpenAI-shaped endpoint — Groq, Mistral, DeepSeek, xAI,
   OpenRouter, Together, Ollama, LM Studio — set AI_BASE_URL to its /v1 root. */
const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const API_KEY  = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY ||
                 process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || '';
const BASE = (process.env.AI_BASE_URL || {
  anthropic:'https://api.anthropic.com',
  openai:   'https://api.openai.com/v1',
  gemini:   'https://generativelanguage.googleapis.com/v1beta'
}[PROVIDER] || '').replace(/\/+$/,'');
const MODEL = process.env.AI_MODEL || process.env.ANTHROPIC_MODEL || {
  anthropic:'claude-haiku-4-5', openai:'gpt-5-mini', gemini:'gemini-2.0-flash'
}[PROVIDER] || '';
const MAX_BODY = 24_000;          // characters of JSON we will accept
const PER_IP_PER_MIN = 12;
const BUDGET = Number(process.env.DAILY_REQUEST_BUDGET || 2000);

const hits = new Map();           // ip -> [timestamps]
let dayKey = '';
let dayCount = 0;

const SYSTEMS = {
  rewrite:
    'You are an expert resume editor for senior engineering CVs. You rewrite lines to be concise, specific ' +
    'and achievement-oriented. Rules: start with a strong past-tense action verb; keep every real number, tool ' +
    'and technology from the input; NEVER invent metrics, employers, dates or technologies that are not in the ' +
    'input; no first person; no cliches; one sentence under 180 characters. ' +
    'Reply with JSON only: {"options":["...","...","..."]}',
  summary:
    'You are an expert resume editor. Rewrite the professional summary to 60-80 words, two to three sentences, ' +
    'leading with the specialism and years of experience. Keep every real number and technology; NEVER invent ' +
    'facts. No first person, no cliches. Reply with JSON only: {"options":["...","...","..."]}',
  review:
    'You are a hiring manager reviewing an engineering resume. Identify the most important concrete problems ' +
    'with the WRITING (clarity, specificity, evidence, ordering). Do not comment on formatting or fonts. ' +
    'Reply with JSON only: {"findings":[{"msg":"short headline","why":"one or two sentences"}]} — at most 6.',
  skills:
    'You extract technical skills from engineering experience text. Only list skills clearly evidenced by the ' +
    'text. Never invent tools the person has not mentioned. Reply with JSON only: {"skills":["..."]} — at most 15.'
};

const MAX_TOKENS = { rewrite: 700, summary: 1200, review: 1500, skills: 700 };

function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  return (Array.isArray(f) ? f[0] : String(f || '')).split(',')[0].trim()
      || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();           // keep memory bounded
  return list.length > PER_IP_PER_MIN;
}

function overBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  return ++dayCount > BUDGET;
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET')     return res.status(200).json({ ok: true, provider: PROVIDER, model: MODEL });
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Use POST' });

  if (!API_KEY) return res.status(503).json({ error: 'Server has no AI_API_KEY configured' });
  if (!BASE)    return res.status(503).json({ error: 'Server has no AI_BASE_URL for provider ' + PROVIDER });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Bad JSON body' });

  const task = String(body.task || '');
  const prompt = String(body.prompt || '');
  // hasOwnProperty, not truthiness: SYSTEMS['constructor'] is otherwise truthy
  if (!Object.prototype.hasOwnProperty.call(SYSTEMS, task))
    return res.status(400).json({ error: 'Unknown task' });
  if (!prompt.trim())  return res.status(400).json({ error: 'Empty prompt' });
  if (prompt.length > MAX_BODY) return res.status(413).json({ error: 'Prompt too large' });

  const ip = clientIp(req);
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many requests — wait a minute.' });
  if (overBudget())    return res.status(429).json({ error: 'Daily budget reached for this deployment.' });

  try {
    const system = SYSTEMS[task];
    const maxTokens = MAX_TOKENS[task] || 700;
    let url, init;

    if (PROVIDER === 'anthropic') {
      url = BASE + '/v1/messages';
      init = { method:'POST',
        headers:{ 'x-api-key': API_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages:[{role:'user', content: prompt}] }) };
    } else if (PROVIDER === 'gemini') {
      url = `${BASE}/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(API_KEY)}`;
      init = { method:'POST', headers:{ 'content-type':'application/json' },
        body: JSON.stringify({ system_instruction:{ parts:[{ text: system }] },
          contents:[{ role:'user', parts:[{ text: prompt }] }],
          generationConfig:{ maxOutputTokens: maxTokens, temperature: 0.6 } }) };
    } else {                                  // openai and every clone of it
      url = BASE + '/chat/completions';
      init = { method:'POST',
        headers:{ authorization:'Bearer ' + API_KEY, 'content-type':'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0.6,
          messages:[{role:'system', content: system}, {role:'user', content: prompt}] }) };
    }

    const r = await fetch(url, init);
    const data = await r.json();
    if (!r.ok) {
      // never leak the upstream error verbatim — it can echo key/account details
      // never log error.message — some providers echo a partial key in it
      console.error(PROVIDER + ' error', r.status, data?.error?.type || '(no type)');
      return res.status(502).json({ error: 'Upstream model error (' + r.status + ')' });
    }
    const text =
      PROVIDER === 'anthropic' ? (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('')
    : PROVIDER === 'gemini'    ? ((data.candidates || [])[0]?.content?.parts || []).map(x => x.text || '').join('')
    :                            String((data.choices || [])[0]?.message?.content || '');
    return res.status(200).json({ text: text.trim() });
  } catch (err) {
    console.error('rewrite failed', err);
    return res.status(500).json({ error: 'Request failed' });
  }
}
