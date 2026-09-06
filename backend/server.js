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
 * Returns raw { role, results: [{title, url, content, raw_content, publishedDate}] }
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
      max_results: 5,
      days: 3,                         // Tavily's own recency filter, matches the brief
      include_answer: false,
      include_raw_content: 'markdown'  // markdown (not plain text) keeps the actual
                                        // hyperlinks on a listing page, so the LLM can
                                        // pull out each job's real posting URL instead
                                        // of only ever having the listing page's own URL
    })
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed for "${role}": ${response.status}`);
  }

  const data = await response.json();
  return { role, results: data.results || [] };
}

/**
 * Ask the LLM to turn raw search results into clean job objects, tagging
 * each with its experience level rather than dropping non-fresher roles.
 *
 * IMPORTANT: this runs ONE SMALLER REQUEST PER ROLE rather than batching
 * every role into a single giant prompt. Groq's free tier caps a single
 * request at 8,000 tokens — batching multiple roles' full page content
 * together blew well past that (12,000+ tokens) and got rejected outright
 * (413), even before retries could help. Per-role requests stay small
 * enough to fit, and roles run in parallel so total wall-clock time is
 * about the same as one big call would have been.
 */
async function structureWithLLM(perRoleResults, roles, maxAgeDays) {
  const availableModels = await getAvailableGroqModels();
  const modelsToTry = pickModelsToTry(availableModels, [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-20b',
    'openai/gpt-oss-120b',
    'qwen/qwen3-32b',
    'moonshotai/kimi-k2-instruct'
  ]);

  if (modelsToTry.length === 0) {
    throw new Error('No usable Groq models found for this API key.');
  }

  const perRoleJobs = await Promise.all(
    perRoleResults.map(({ role, results }) =>
      structureOneRole(role, results, maxAgeDays, modelsToTry)
    )
  );

  return perRoleJobs.flat();
}

/**
 * Build a prompt scoped to ONE role's results and run it through Groq.
 * Keeping this per-role (rather than all roles combined) is what keeps
 * each request under the free-tier token ceiling.
 */
async function structureOneRole(role, results, maxAgeDays, modelsToTry) {
  if (results.length === 0) return [];

  const snippets = results.map((r, i) => {
    // Cap content length to keep each request comfortably under Groq's
    // free-tier per-request token limit (8,000 tokens ≈ ~30,000 characters
    // total prompt). With up to 5 results per role, ~1200 chars each keeps
    // total content around 6,000 chars — leaves headroom for the prompt
    // instructions and JSON schema too.
    const body = (r.raw_content || r.content || '').slice(0, 1200);
    return `[#${i}] URL: ${r.url}\nPage title: ${r.title}\nPublished: ${r.published_date || 'unknown'}\nContent:\n${body}`;
  }).join('\n\n');

  const prompt = `You are turning raw web page content into a clean list of individual UAE job postings for the role "${role}", across ALL experience levels — do not filter by seniority.

Some of the pages below are LISTING or AGGREGATOR pages (e.g. a LinkedIn or Bayt search-results page titled something like "${role} Jobs in UAE — 667 Open Roles"). These pages often contain MANY individual job postings within their content, each with its own title, company, and a link. Read through the content of each page and extract every distinct individual job you can clearly identify, not just the page's own title.

Rules — apply strictly:
- Include postings at any experience level (entry-level/fresher, mid-level, senior, or unspecified). Do NOT drop a posting just because it looks senior or experienced — classify it instead, using the "experienceLevel" field.
- For "experienceLevel", use exactly one of these four values: "Entry-level / Fresher", "Mid-level", "Senior-level", "Not specified".
- Only include postings located in the UAE (Dubai, Abu Dhabi, Sharjah, or other emirates).
- For "link": the content below is in markdown, so individual job links usually appear as markdown links like [Job Title](https://...). Use that specific job's own URL whenever you can find one. Only fall back to the page's own URL (given above each block) if no specific per-job link is present in the content — never fabricate a URL that isn't in the text below.
- Only include postings that appear to be from the last ${maxAgeDays} days, OR where the page itself is clearly a live/current listing (dated within the last week, or says "today"/"new") even if an exact per-job date isn't shown. If a page gives no date signal at all and isn't clearly current, drop only that specific job.
- NEVER invent a job whose title or company isn't actually present in the content below.
- If nothing qualifies, return an empty jobs array.

Raw search results for "${role}":
${snippets}

Respond ONLY with a JSON object (no markdown fences, no prose) in this exact shape:
{
  "jobs": [
    {
      "title": "string",
      "company": "string",
      "location": "string",
      "postedRelative": "e.g. '2 days ago' or 'Today'",
      "experienceLevel": "one of: Entry-level / Fresher, Mid-level, Senior-level, Not specified",
      "matchedRole": "${role}",
      "description": "one sentence, plain language",
      "link": "the specific job posting URL if found in the content, otherwise the page URL given above"
    }
  ]
}`;

  return callGroqWithFallback(prompt, modelsToTry);
}

/**
 * Send one prompt to Groq, retrying transient failures and falling back
 * across models as needed. Returns the parsed "jobs" array, or throws
 * after every model/attempt is exhausted.
 */
async function callGroqWithFallback(prompt, modelsToTry) {
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
            max_tokens: 2000,
            response_format: { type: 'json_object' } // forces valid JSON output where the model supports it
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
          break; // non-transient (e.g. this specific model rejected, or still too large) — skip to next model
        }

        const data = await response.json();
        const finishReason = data.choices?.[0]?.finish_reason;
        const text = data.choices?.[0]?.message?.content || '';

        if (finishReason === 'length') {
          console.error(`Groq response truncated (model: ${model}, attempt: ${attempt}) — hit max_tokens.`);
          lastError = new Error('LLM structuring failed: response truncated (max_tokens).');
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        const parsed = extractJson(text);
        if (parsed) {
          return parsed.jobs || [];
        }

        console.error(`Failed to parse LLM output (model: ${model}, attempt: ${attempt}). Raw text:`, text);
        lastError = new Error('LLM structuring failed: could not parse JSON from model output.');
        await sleep(RETRY_DELAY_MS * attempt);
        continue;

      } catch (err) {
        lastError = err;
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
    console.warn(`Model ${model} unavailable/exhausted, falling back to next model.`);
  }

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

/**
 * Pull a JSON object out of a model's raw text response. Handles the
 * common failure modes: markdown code fences, stray prose before/after
 * the JSON, or minor leading/trailing whitespace. Returns null (not a
 * throw) if nothing usable is found, so the caller can decide to retry.
 */
function extractJson(text) {
  if (!text) return null;

  // Strip markdown code fences if present.
  let cleaned = text.replace(/```json|```/g, '').trim();

  // Try a direct parse first (the common, well-behaved case).
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Fall through to a more forgiving extraction below.
  }

  // Some models wrap the JSON in a sentence or two. Grab from the first
  // '{' to the matching last '}' and try again.
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // Still not valid — give up and let the caller retry.
    }
  }

  return null;
}

app.listen(PORT, () => {
  console.log(`Wharf backend running on http://localhost:${PORT}`);
  console.log(`Point the frontend's BACKEND_BASE_URL at this server's public URL, e.g. http://localhost:${PORT}`);
});
