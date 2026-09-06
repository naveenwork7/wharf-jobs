/**
 * Wharf backend — the piece that actually does live job discovery.
 *
 * Why this has to exist separately from index.html:
 * Real web search / AI parsing needs a secret API key. Any key placed in
 * client-side JS is visible to every visitor via browser dev tools, so it
 * WILL get scraped and abused. This tiny server holds the key, does the
 * search, and hands the browser back only clean JSON.
 *
 * It also solves the "5-minute auto-refresh per user" cost problem from
 * the brief: results are cached per role-set for CACHE_TTL_MS, so ten
 * users all searching "Data Analyst" within a few minutes of each other
 * share one upstream search call instead of firing ten.
 *
 * Search engine used here: Tavily (https://tavily.com) — has a generous
 * free tier and is built for exactly this (LLM-oriented web search with
 * real results, not hallucination). Swap in SerpAPI/Perplexity/Bing the
 * same way if you prefer.
 *
 * Setup:
 *   npm init -y
 *   npm install express cors node-fetch dotenv
 *   echo "TAVILY_API_KEY=your_key_here" > .env
 *   echo "GROQ_API_KEY=your_key_here" >> .env
 *   node server.js
 *
 * Then open index.html (or serve it statically — see bottom of this file)
 * and it will call this server at /api/jobs.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

// Set ALLOWED_ORIGIN to your GitHub Pages URL (e.g. https://yourusername.github.io)
// once it's live, so only your site can call this API. Defaults to "*" (open)
// for easy local testing.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// Simple health-check route so you can confirm the backend deployed
// correctly by just opening its URL in a browser.
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'wharf-backend', endpoint: 'POST /api/jobs' });
});

const PORT = process.env.PORT || 3001;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CACHE_TTL_MS = 3 * 60 * 1000; // shared cache window, shorter than the 5-min client refresh

// In-memory shared cache: { cacheKey: { timestamp, jobs } }
// For production / multiple server instances, swap this for Redis.
const cache = new Map();

const JOB_SOURCES = [
  'linkedin.com/jobs',
  'bayt.com',
  'indeed.com (UAE)',
  'gulftalent.com',
  'naukrigulf.com',
  'monstergulf.com',
  'dubizzle.com/jobs'
];

app.post('/api/jobs', async (req, res) => {
  try {
    const { roles = [], location = 'UAE', maxAgeDays = 3 } = req.body;

    if (!Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ error: 'Provide at least one role.' });
    }

    const cacheKey = JSON.stringify([...roles].sort().map(r => r.toLowerCase())) + `|${maxAgeDays}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return res.json({ jobs: cached.jobs, cached: true, debug: cached.debug });
    }

    // 1. Run a live web search per role (kept separate so results can be
    //    tagged with which role they matched).
    const perRoleResults = await Promise.all(
      roles.map(role => searchForRole(role, location))
    );

    // Diagnostic snapshot of what the search actually found, before any
    // AI filtering — this is what tells you the pipeline is really
    // running, and how aggressively the LLM step is filtering things out.
    const debug = {
      searchedAt: new Date().toISOString(),
      rawResultsPerRole: perRoleResults.map(({ role, results }) => ({
        role,
        rawCount: results.length,
        sampleTitles: results.slice(0, 3).map(r => r.title)
      })),
      totalRawResults: perRoleResults.reduce((sum, r) => sum + r.results.length, 0)
    };
    console.log('Search debug:', JSON.stringify(debug, null, 2));

    // 2. Hand the raw search snippets to an LLM to structure + validate
    //    (fresher-level only, UAE only, posted within maxAgeDays, no
    //    hallucinated postings — it must anchor every job to a real
    //    snippet/link it was given).
    const structuredJobs = await structureWithLLM(perRoleResults, roles, maxAgeDays);
    debug.filteredCount = structuredJobs.length;

    cache.set(cacheKey, { timestamp: Date.now(), jobs: structuredJobs, debug });

    res.json({ jobs: structuredJobs, cached: false, debug });

  } catch (err) {
    console.error('Search failed:', err);
    res.status(502).json({ error: 'Upstream search failed. Try again shortly.', details: err.message });
  }
});

/**
 * Live web search for a single role using Tavily.
 * Returns raw { role, results: [{title, url, content, publishedDate}] }
 */
async function searchForRole(role, location) {
  const query = `${role} jobs ${location} site:linkedin.com OR site:bayt.com OR site:indeed.com OR site:gulftalent.com OR site:naukrigulf.com OR site:monstergulf.com`;

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: 'advanced',
      max_results: 10,
      days: 3,               // Tavily's own recency filter, matches the brief
      include_answer: false
    })
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed for "${role}": ${response.status}`);
  }

  const data = await response.json();
  return { role, results: data.results || [] };
}

/**
 * Ask the LLM to turn raw search snippets into clean job objects, tagging
 * each with its experience level rather than dropping non-fresher roles —
 * this lets the frontend filter by level locally without a new search.
 */
async function structureWithLLM(perRoleResults, roles, maxAgeDays) {
  const context = perRoleResults.map(({ role, results }) => {
    const snippets = results.map((r, i) =>
      `[${role} #${i}] URL: ${r.url}\nTitle: ${r.title}\nPublished: ${r.published_date || 'unknown'}\nSnippet: ${r.content?.slice(0, 500)}`
    ).join('\n\n');
    return `--- Search results for role "${role}" ---\n${snippets || '(no results returned)'}`;
  }).join('\n\n');

  const prompt = `You are turning raw web search results into a clean list of UAE job postings, across ALL experience levels — do not filter by seniority.

Rules — apply strictly:
- Include postings at any experience level (entry-level/fresher, mid-level, senior, or unspecified). Do NOT drop a posting just because it looks senior or experienced — classify it instead, using the "experienceLevel" field.
- For "experienceLevel", use exactly one of these four values: "Entry-level / Fresher", "Mid-level", "Senior-level", "Not specified".
- Only include postings located in the UAE (Dubai, Abu Dhabi, Sharjah, or other emirates).
- Only include postings that appear to be from the last ${maxAgeDays} days. If you cannot tell the posting date, DROP it rather than guessing.
- NEVER invent a job that is not directly backed by one of the search result snippets below. Every job you output must correspond to a real URL from the input.
- If nothing in the results qualifies, return an empty jobs array — do not pad with unrelated results.

Roles searched: ${roles.join(', ')}

Raw search results:
${context}

Respond ONLY with a JSON object (no markdown fences, no prose) in this exact shape:
{
  "jobs": [
    {
      "title": "string",
      "company": "string",
      "location": "string",
      "postedRelative": "e.g. '2 days ago' or 'Today'",
      "experienceLevel": "one of: Entry-level / Fresher, Mid-level, Senior-level, Not specified",
      "matchedRole": "which searched role this corresponds to",
      "description": "one sentence, plain language",
      "link": "the exact URL from the snippet"
    }
  ]
}`;

  // Groq (https://groq.com) — free tier, no credit card, fast inference.
  // Rather than hardcode specific model names (which Groq periodically
  // renames/retires/restricts per-account), we ask the account's own
  // /models endpoint what it actually has access to right now, and pick
  // from that live list. This is the "auto-pick" approach — it can't go
  // stale the way a hardcoded model name can.
  const PREFERRED_MODEL_ORDER = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-20b',
    'openai/gpt-oss-120b',
    'qwen/qwen3-32b',
    'moonshotai/kimi-k2-instruct'
  ];

  const availableModels = await getAvailableGroqModels();
  const modelsToTry = pickModelsToTry(availableModels, PREFERRED_MODEL_ORDER);

  if (modelsToTry.length === 0) {
    throw new Error('No usable Groq models found for this API key.');
  }

  const MAX_ATTEMPTS_PER_MODEL = 2;
  const RETRY_DELAY_MS = 1500;

  let lastError = null;

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 2000
          })
        });

        if (!response.ok) {
          const errorBody = await response.text();
          const isTransient = response.status === 503 || response.status === 429;
          console.error(`Groq API error ${response.status} (model: ${model}, attempt: ${attempt}):`, errorBody);
          lastError = new Error(`LLM structuring failed: ${response.status} — ${errorBody}`);

          if (isTransient) {
            await sleep(RETRY_DELAY_MS * attempt);
            continue; // retry same model, or fall through to next model after MAX_ATTEMPTS_PER_MODEL
          }
          break; // non-transient (e.g. this specific model rejected) — skip to next model, don't retry it
        }

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || '';
        const cleaned = text.replace(/```json|```/g, '').trim();

        try {
          const parsed = JSON.parse(cleaned);
          return parsed.jobs || [];
        } catch (e) {
          console.error('Failed to parse LLM output:', text);
          return [];
        }

      } catch (err) {
        lastError = err;
        // Network-level error (not an HTTP error response) — also worth a retry.
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
    console.warn(`Model ${model} unavailable/exhausted, falling back to next model.`);
  }

  // All models/attempts exhausted — surface the last real error.
  throw lastError || new Error('LLM structuring failed: all models unavailable.');
}

/**
 * Ask Groq what models this API key actually has access to right now.
 * Returns an array of model ID strings (e.g. ['llama-3.3-70b-versatile', ...]).
 */
async function getAvailableGroqModels() {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` }
    });
    if (!response.ok) {
      console.error('Could not fetch Groq model list:', response.status, await response.text());
      return [];
    }
    const data = await response.json();
    return (data.data || []).map(m => m.id);
  } catch (err) {
    console.error('Error fetching Groq model list:', err);
    return [];
  }
}

/**
 * Order the account's actually-available models by our preference list,
 * so we try the best/fastest ones first but will happily use whatever
 * this specific account has access to. Falls back to trying every
 * available model (in whatever order the API returned) if none of our
 * preferred names match — this way a completely new model lineup still
 * works without any code change.
 */
function pickModelsToTry(availableModels, preferredOrder) {
  const available = new Set(availableModels);
  const preferredAvailable = preferredOrder.filter(m => available.has(m));

  if (preferredAvailable.length > 0) return preferredAvailable;

  // None of our preferred names matched — just try whatever text-capable
  // models this account does have (skip obvious audio/TTS/guard models).
  return availableModels.filter(m =>
    !/whisper|tts|guard|prompt-guard/i.test(m)
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.listen(PORT, () => {
  console.log(`Wharf backend running on http://localhost:${PORT}`);
  console.log(`Point the frontend's BACKEND_BASE_URL at this server's public URL, e.g. http://localhost:${PORT}`);
});
