/**
 * Cloudflare Pages Function version of /api/rewrite.
 * Use this file INSTEAD of api/rewrite.js if you deploy to Cloudflare Pages
 * (delete the other one, or Cloudflare will ignore it anyway).
 *
 * Set AI_API_KEY as an encrypted environment variable in the Pages project
 * settings, plus AI_PROVIDER (anthropic | openai | gemini | compatible).
 * Optional: AI_MODEL, AI_BASE_URL (required for "compatible"), ALLOWED_ORIGIN.
 */

const DEFAULT_BASE = {
  anthropic:'https://api.anthropic.com',
  openai:   'https://api.openai.com/v1',
  gemini:   'https://generativelanguage.googleapis.com/v1beta'
};
const DEFAULT_MODEL = {
  anthropic:'claude-haiku-4-5', openai:'gpt-5-mini', gemini:'gemini-2.0-flash'
};
const cfg = env => {
  const provider = (env.AI_PROVIDER || 'anthropic').toLowerCase();
  return {
    provider,
    key:   env.AI_API_KEY || env.ANTHROPIC_API_KEY || '',
    base:  (env.AI_BASE_URL || DEFAULT_BASE[provider] || '').replace(/\/+$/,''),
    model: env.AI_MODEL || env.ANTHROPIC_MODEL || DEFAULT_MODEL[provider] || ''
  };
};

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
const MAX_BODY = 24000;
const PER_IP_PER_MIN = 12;
const hits = new Map();          // best-effort only: Workers isolates are not shared
function rateLimited(ip){
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > PER_IP_PER_MIN;
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const cors = env => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  'content-type': 'application/json'
});
const json = (obj, status, env) => new Response(JSON.stringify(obj), { status, headers: cors(env) });

export const onRequestOptions = ({ env }) => new Response(null, { status: 204, headers: cors(env) });
export const onRequestGet = ({ env }) => {
  const c = cfg(env);
  return json({ ok: true, provider: c.provider, model: c.model }, 200, env);
};

export async function onRequestPost({ request, env }) {
  const c = cfg(env);
  if (!c.key)  return json({ error: 'Server has no AI_API_KEY configured' }, 503, env);
  if (!c.base) return json({ error: 'Server has no AI_BASE_URL for provider ' + c.provider }, 503, env);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON body' }, 400, env); }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (rateLimited(ip)) return json({ error: 'Too many requests — wait a minute.' }, 429, env);

  const task = String(body?.task || '');
  const prompt = String(body?.prompt || '');
  // hasOwnProperty, not truthiness: SYSTEMS['constructor'] is otherwise truthy
  if (!own(SYSTEMS, task)) return json({ error: 'Unknown task' }, 400, env);
  if (!prompt.trim()) return json({ error: 'Empty prompt' }, 400, env);
  if (prompt.length > MAX_BODY) return json({ error: 'Prompt too large' }, 413, env);

  try {
    const system = SYSTEMS[task], maxTokens = MAX_TOKENS[task] || 700;
    let url, init;
    if (c.provider === 'anthropic') {
      url = c.base + '/v1/messages';
      init = { method:'POST',
        headers:{ 'x-api-key': c.key, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
        body: JSON.stringify({ model:c.model, max_tokens:maxTokens, system, messages:[{role:'user', content:prompt}] }) };
    } else if (c.provider === 'gemini') {
      url = `${c.base}/models/${encodeURIComponent(c.model)}:generateContent?key=${encodeURIComponent(c.key)}`;
      init = { method:'POST', headers:{ 'content-type':'application/json' },
        body: JSON.stringify({ system_instruction:{ parts:[{ text: system }] },
          contents:[{ role:'user', parts:[{ text: prompt }] }],
          generationConfig:{ maxOutputTokens: maxTokens, temperature: 0.6 } }) };
    } else {
      url = c.base + '/chat/completions';
      init = { method:'POST',
        headers:{ authorization:'Bearer ' + c.key, 'content-type':'application/json' },
        body: JSON.stringify({ model:c.model, max_tokens:maxTokens, temperature:0.6,
          messages:[{role:'system', content:system}, {role:'user', content:prompt}] }) };
    }
    const r = await fetch(url, init);
    const data = await r.json();
    if (!r.ok) return json({ error: 'Upstream model error (' + r.status + ')' }, 502, env);
    const text =
      c.provider === 'anthropic' ? (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('')
    : c.provider === 'gemini'    ? ((data.candidates || [])[0]?.content?.parts || []).map(x => x.text || '').join('')
    :                              String((data.choices || [])[0]?.message?.content || '');
    return json({ text: text.trim() }, 200, env);
  } catch {
    return json({ error: 'Request failed' }, 500, env);
  }
}
