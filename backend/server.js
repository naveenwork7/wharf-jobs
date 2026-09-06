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
    // llama-3.3-70b handles JSON mode + long extraction reliably.
    // 8b-instant is the fast fallback. The openai/gpt-oss-* models are
    // listed last because they've been returning json_validate_failed
    // on this prompt shape.
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'qwen/qwen3-32b',
    'moonshotai/kimi-k2-instruct',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b'
  ]);

  if (modelsToTry.length === 0) {
    throw new Error('No usable Groq models found for this API key.');
  }

  // Run roles SEQUENTIALLY, not in parallel. Groq's free-tier limit is
  // 8,000 tokens per MINUTE across the org — firing every role's request
  // at once stacks them against the same budget and trips a 413 even when
  // each request would fit on its own. Sequential requests spread the
  // spend out and succeed.
  const perRoleJobs = [];
  for (const { role, results } of perRoleResults) {
    try {
      const jobs = await structureOneRole(role, results, maxAgeDays, modelsToTry);
      perRoleJobs.push(jobs);
    } catch (err) {
      // One role failing shouldn't lose the other roles' results.
      console.error(`Structuring failed for role "${role}":`, err.message);
      perRoleJobs.push([]);
    }
  }

  // The same posting often appears on several listing pages (and across
  // roles when searches overlap), so dedupe on title+company.
  const seen = new Set();
  return perRoleJobs.flat().filter(job => {
    const key = `${(job.title || '').toLowerCase().trim()}|${(job.company || '').toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build a prompt scoped to ONE role's results and run it through Groq.
 * Keeping this per-role (rather than all roles combined) is what keeps
 * each request under the free-tier token ceiling.
 */
async function structureOneRole(role, results, maxAgeDays, modelsToTry) {
  if (results.length === 0) return [];

  // Budget the content to fit Groq's free tier: 8,000 TOKENS PER MINUTE
  // (not per request). Roughly 4 chars per token, so ~8,000 chars of
  // content ≈ 2,000 tokens, leaving room for instructions, the JSON
  // schema, and the response itself — and for a second role's request
  // within the same minute. Splitting the budget across results means
  // fewer results each get more content, which matters because a listing
  // page's actual jobs sit past the nav/header boilerplate.
  const TOTAL_CONTENT_BUDGET = 8000;
  const perResultBudget = Math.floor(TOTAL_CONTENT_BUDGET / results.length);

  // Pull real job URLs out of the markdown ourselves rather than trusting
  // the model to transcribe them. Models frequently truncate, mangle, or
  // invent long URLs — but they're reliable at picking an INDEX from a
  // list. So we build the candidate link list here, hand it to the model
  // numbered, and have it return the index. We then map the index back to
  // the real URL in code, which makes fabricated links impossible.
  const linkCandidates = [];
  results.forEach(r => {
    const body = (r.raw_content || r.content || '').slice(0, perResultBudget);
    for (const [, text, url] of body.matchAll(/\[([^\]]{3,120})\]\((https?:\/\/[^)\s]+)\)/g)) {
      if (isLikelyJobUrl(url) && !linkCandidates.some(c => c.url === url)) {
        linkCandidates.push({ url, text: text.trim() });
      }
    }
  });

  const linkList = linkCandidates.length
    ? linkCandidates.map((c, i) => `L${i}: ${c.text} -> ${c.url}`).join('\n')
    : '(no per-job links found — use the page URL fallback)';

  const snippets = results.map((r, i) => {
    const body = (r.raw_content || r.content || '').slice(0, perResultBudget);
    return `[#${i}] PAGE_URL: ${r.url}\nPage title: ${r.title}\nPublished: ${r.published_date || 'unknown'}\nContent:\n${body}`;
  }).join('\n\n');

  const prompt = `You are turning raw web page content into a clean list of individual UAE job postings for the role "${role}", across ALL experience levels — do not filter by seniority.

Some of the pages below are LISTING or AGGREGATOR pages (e.g. a LinkedIn or Bayt search-results page titled something like "${role} Jobs in UAE — 667 Open Roles"). These pages contain MANY individual job postings within their content, each with its own title, company, and a link. Read through the ENTIRE content of each page and extract EVERY distinct individual job you can identify.

BE THOROUGH: extract every distinct real job you can find in the content — typically 5-15 across these pages, not just one or two. Do not stop after the first job you find on a page; keep going through the content you were given. Only return few jobs if the content genuinely contains few.

CANDIDATE JOB LINKS (already extracted from the pages for you):
${linkList}

Rules — apply strictly:
- Include postings at any experience level (entry-level/fresher, mid-level, senior, or unspecified). Do NOT drop a posting just because it looks senior or experienced — classify it instead, using the "experienceLevel" field.
- For "experienceLevel", use exactly one of these four values: "Entry-level / Fresher", "Mid-level", "Senior-level", "Not specified".
- Only include postings located in the UAE (Dubai, Abu Dhabi, Sharjah, or other emirates).
- For "linkId": match each job to the CANDIDATE JOB LINK whose text best corresponds to that job, and return its id (e.g. "L3"). If no candidate link matches that job, return the exact PAGE_URL of the page you found it on in the "pageUrl" field instead and set "linkId" to null. NEVER type out a URL yourself in "linkId" — only ever an "L" id from the list above.
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
      "linkId": "the matching candidate link id like 'L3', or null if none matches",
      "pageUrl": "only if linkId is null: the exact PAGE_URL of the page this job came from"
    }
  ]
}`;

  const rawJobs = await callGroqWithFallback(prompt, modelsToTry);

  // Resolve linkId back to the real URL in code. Because the model only
  // ever returns an index, it cannot fabricate or mangle a URL — every
  // link we output is one we actually extracted from the page content.
  const pageUrls = new Set(results.map(r => r.url));

  return rawJobs.map(job => {
    let link = null;

    if (job.linkId) {
      const idx = parseInt(String(job.linkId).replace(/^L/i, ''), 10);
      if (!Number.isNaN(idx) && linkCandidates[idx]) {
        link = linkCandidates[idx].url;
      }
    }

    // Fall back to the source page only if it's genuinely one of the pages
    // we searched — never a URL the model made up.
    if (!link && job.pageUrl && pageUrls.has(job.pageUrl)) {
      link = job.pageUrl;
    }

    // Last resort: the first page we searched for this role, so the card
    // still links somewhere real rather than nowhere.
    if (!link) {
      link = results[0]?.url || null;
    }

    const { linkId, pageUrl, ...rest } = job;
    return { ...rest, link };
  });
}

/**
 * Heuristic: does this URL look like an individual job posting rather than
 * a nav link, login page, or site chrome? Keeps the candidate list focused
 * so the model isn't picking from dozens of irrelevant links.
 */
function isLikelyJobUrl(url) {
  const lower = url.toLowerCase();

  // Obvious non-job destinations found all over job boards.
  const junk = /\/(login|signup|register|about|privacy|terms|contact|help|faq|blog|pricing|app|download|cookie)/;
  if (junk.test(lower)) return false;

  // Common shapes of individual job-posting URLs across the major boards.
  const jobIsh = /(\/jobs?\/|\/job-|\/vacancy|\/vacancies|\/careers?\/|viewjob|\/posting|jk=|currentJobId=)/;
  return jobIsh.test(lower);
}

/**
 * Send one prompt to Groq, retrying transient failures and falling back
 * across models as needed. Returns the parsed "jobs" array, or throws
 * after every model/attempt is exhausted.
 */
async function callGroqWithFallback(prompt, modelsToTry) {
  const MAX_ATTEMPTS_PER_MODEL = 2;
  const RETRY_DELAY_MS = 1500;
  const RATE_LIMIT_DELAY_MS = 20000; // token budget refills per minute

  let lastError = null;

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        // Some models reject response_format json_object on this prompt
        // ("json_validate_failed"). If the first attempt fails that way,
        // the second attempt drops JSON mode and relies on extractJson()
        // to pull the object out of a normal text response instead.
        const useJsonMode = attempt === 1;

        const requestBody = {
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 3000
        };
        if (useJsonMode) {
          requestBody.response_format = { type: 'json_object' };
        }

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorBody = await response.text();
          // 413 here is Groq's tokens-per-minute rate limit, not a permanent
          // rejection — waiting for the window to roll over usually clears it.
          const isRateLimited = response.status === 429 || response.status === 413;
          const isTransient = response.status === 503 || isRateLimited;
          const isJsonModeFailure = errorBody.includes('json_validate_failed');
          console.error(`Groq API error ${response.status} (model: ${model}, attempt: ${attempt}, jsonMode: ${useJsonMode}):`, errorBody);
          lastError = new Error(`LLM structuring failed: ${response.status} — ${errorBody}`);

          if (isTransient || isJsonModeFailure) {
            // Rate limits need a longer wait than other transient errors,
            // since the token budget refills on a per-minute window.
            const delay = isRateLimited ? RATE_LIMIT_DELAY_MS : RETRY_DELAY_MS * attempt;
            await sleep(delay);
            continue;
          }
          break; // genuinely non-transient — move to the next model
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
