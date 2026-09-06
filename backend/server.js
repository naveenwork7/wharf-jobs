/**
 * Ask the LLM to turn raw search snippets into clean job objects.
 * Now processes ONE ROLE PER CALL to stay well under Groq's TPM limits —
 * batching all roles into a single prompt was pushing requests to
 * 10-12k tokens against an 8k/min cap. 

 
 */
async function structureWithLLM(perRoleResults, roles, maxAgeDays) {
  const allJobs = [];
  let lastError = null;

  for (const { role, results } of perRoleResults) {
    try {
      const jobs = await structureRoleWithLLM(role, results, maxAgeDays);
      allJobs.push(...jobs);
    } catch (err) {
      console.error(`Structuring failed for role "${role}":`, err.message);
      lastError = err;
      // Keep going — one role failing shouldn't kill the whole batch.
    }
  }

  // Only throw if EVERY role failed and we have nothing to show.
  if (allJobs.length === 0 && lastError) {
    throw lastError;
  }

  return allJobs;
}

/**
 * Structure a single role's search results into job objects.
 * Kept small and separate from the multi-role orchestration above so
 * each Groq request has a bounded, predictable token size.
 */
async function structureRoleWithLLM(role, results, maxAgeDays) {
  // Cap how many results and how much content per result we send.
  // 8 results x 3000 chars was the culprit — trim both dimensions.
  const MAX_RESULTS = 5;
  const MAX_CHARS_PER_RESULT = 1200;

  const snippets = results.slice(0, MAX_RESULTS).map((r, i) => {
    const body = (r.raw_content || r.content || '').slice(0, MAX_CHARS_PER_RESULT);
    return `[#${i}] URL: ${r.url}\nPage title: ${r.title}\nPublished: ${r.published_date || 'unknown'}\nContent:\n${body}`;
  }).join('\n\n');

  const context = `--- Search results for role "${role}" ---\n${snippets || '(no results returned)'}`;

  const prompt = `You are turning raw web page content into a clean list of individual UAE job postings for the role "${role}", across ALL experience levels — do not filter by seniority.

Some of the pages below are LISTING or AGGREGATOR pages (e.g. a LinkedIn or Bayt search-results page titled something like "Software Engineer Jobs in UAE — 667 Open Roles"). These pages often contain MANY individual job postings within their content. Read through the full content of each page and extract every distinct individual job you can clearly identify, not just the page's own title.

Rules — apply strictly:
- Include postings at any experience level (entry-level/fresher, mid-level, senior, or unspecified). Do NOT drop a posting just because it looks senior or experienced — classify it instead, using the "experienceLevel" field.
- For "experienceLevel", use exactly one of: "Entry-level / Fresher", "Mid-level", "Senior-level", "Not specified".
- Only include postings located in the UAE (Dubai, Abu Dhabi, Sharjah, or other emirates).
- For "link": if the content clearly gives a direct URL to that specific job posting, use it. If you can only identify the job from a listing page, use that listing page's URL — do not fabricate a URL that isn't present in the content.
- Only include postings that appear to be from the last ${maxAgeDays} days, OR where the page is clearly a live/current listing, even if an exact per-job date isn't shown. If a page gives no date signal and isn't clearly current, drop only that job.
- NEVER invent a job whose title or company isn't actually present in the content below.
- If nothing qualifies, return an empty jobs array.

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
      "matchedRole": "${role}",
      "description": "one sentence, plain language",
      "link": "the exact URL from the snippet"
    }
  ]
}`;

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
            max_tokens: 2000, // smaller now that each call is single-role
            response_format: { type: 'json_object' }
          })
        });

        if (!response.ok) {
          const errorBody = await response.text();
          const isTransient = response.status === 503 || response.status === 429;
          console.error(`Groq API error ${response.status} (model: ${model}, role: ${role}, attempt: ${attempt}):`, errorBody);
          lastError = new Error(`LLM structuring failed: ${response.status} — ${errorBody}`);

          if (isTransient) {
            await sleep(RETRY_DELAY_MS * attempt);
            continue;
          }
          break;
        }

        const data = await response.json();
        const finishReason = data.choices?.[0]?.finish_reason;
        const text = data.choices?.[0]?.message?.content || '';

        if (finishReason === 'length') {
          console.error(`Groq response truncated (model: ${model}, role: ${role}, attempt: ${attempt}).`);
          lastError = new Error('LLM structuring failed: response truncated (max_tokens).');
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        const parsed = extractJson(text);
        if (parsed) {
          return parsed.jobs || [];
        }

        console.error(`Failed to parse LLM output (model: ${model}, role: ${role}, attempt: ${attempt}). Raw text:`, text);
        lastError = new Error('LLM structuring failed: could not parse JSON from model output.');
        await sleep(RETRY_DELAY_MS * attempt);
        continue;

      } catch (err) {
        lastError = err;
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
    console.warn(`Model ${model} unavailable/exhausted for role "${role}", falling back to next model.`);
  }

  throw lastError || new Error('LLM structuring failed: all models unavailable.');
}
