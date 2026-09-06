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
      return res.json({ jobs: cached.jobs, cached: true });
    }

    // 1. Run a live web search per role (kept separate so results can be
    //    tagged with which role they matched).
    const perRoleResults = await Promise.all(
      roles.map(role => searchForRole(role, location))
    );

    // 2. Hand the raw search snippets to an LLM to structure + validate
    //    (fresher-level only, UAE only, posted within maxAgeDays, no
    //    hallucinated postings — it must anchor every job to a real
    //    snippet/link it was given).
    const structuredJobs = await structureWithLLM(perRoleResults, roles, maxAgeDays);

    cache.set(cacheKey, { timestamp: Date.now(), jobs: structuredJobs });

    res.json({ jobs: structuredJobs, cached: false });

  } catch (err) {
    console.error('Search failed:', err);
    res.status(502).json({ error: 'Upstream search failed. Try again shortly.' });
  }
});

/**
 * Live web search for a single role using Tavily.
 * Returns raw { role, results: [{title, url, content, publishedDate}] }
 */
async function searchForRole(role, location) {
  const query = `${role} fresher entry level jobs ${location} site:linkedin.com OR site:bayt.com OR site:indeed.com OR site:gulftalent.com OR site:naukrigulf.com OR site:monstergulf.com`;

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
 * Ask Claude to turn raw search snippets into clean, validated job objects.
 * The model is explicitly told to discard anything that isn't clearly a
 * fresher/entry-level UAE posting from the last N days, and to never
 * invent a job that isn't backed by a snippet it was given.
 */
async function structureWithLLM(perRoleResults, roles, maxAgeDays) {
  const context = perRoleResults.map(({ role, results }) => {
    const snippets = results.map((r, i) =>
      `[${role} #${i}] URL: ${r.url}\nTitle: ${r.title}\nPublished: ${r.published_date || 'unknown'}\nSnippet: ${r.content?.slice(0, 500)}`
    ).join('\n\n');
    return `--- Search results for role "${role}" ---\n${snippets || '(no results returned)'}`;
  }).join('\n\n');

  const prompt = `You are filtering raw web search results into a clean list of UAE fresher/entry-level job postings.

Rules — apply strictly:
- Only include postings that are clearly Entry-level / Fresher / 0-1 years experience. If seniority is unclear or looks mid/senior level, DROP it.
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
      "experienceLevel": "Fresher / Entry-level",
      "matchedRole": "which searched role this corresponds to",
      "description": "one sentence, plain language",
      "link": "the exact URL from the snippet"
    }
  ]
}`;

  // Groq (https://groq.com) — free tier, no credit card, and built on custom
  // LPU hardware specifically for fast inference (typically 300-900+
  // tokens/sec, much faster than most free LLM APIs). Uses OpenAI-compatible
  // chat completions format. We still retry + fall back across a couple of
  // stable models in case of rate limits (429) or transient overload.
  const MODEL_FALLBACKS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  const MAX_ATTEMPTS_PER_MODEL = 2;
  const RETRY_DELAY_MS = 1500;

  let lastError = null;

  for (const model of MODEL_FALLBACKS) {
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
          throw lastError; // non-transient error (e.g. bad API key) — no point retrying
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
    console.warn(`Model ${model} exhausted ${MAX_ATTEMPTS_PER_MODEL} attempts, falling back to next model.`);
  }

  // All models/attempts exhausted — surface the last real error.
  throw lastError || new Error('LLM structuring failed: all models unavailable.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.listen(PORT, () => {
  console.log(`Wharf backend running on http://localhost:${PORT}`);
  console.log(`Point the frontend's BACKEND_BASE_URL at this server's public URL, e.g. http://localhost:${PORT}`);
});
