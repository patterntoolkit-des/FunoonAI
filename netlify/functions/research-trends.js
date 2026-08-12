// netlify/functions/research-trends.js
//
// Runs once per design group (frontend caches and reuses the result for
// every colorway). Uses Anthropic's web_search tool to find current
// trending keywords/hashtags/phrases relevant to the design's technique,
// motif, and style. Deliberately color/mood blind so it's reusable
// across every colorway of the same design.
//
// === CHANGE LOG ===
// 1. Explicit recency instruction — prioritize genuinely current trends
//    (last few months) over technically-true but stale results.
// 2. Dedup instruction — keywords, hashtags, and searchPhrases must not
//    overlap or restate each other, each array should add distinct
//    value rather than wasting slots on near-duplicates.
// 3. Explicit hashtag format rule — single token, no internal spaces,
//    starts with #, since these feed directly into Instagram's hashtag
//    field downstream.
// 4. Length guidance on keywords/searchPhrases — these feed Spoonflower's
//    20-char tag limit downstream (in generate-ai-content.js), so favor
//    compact, real search terms over long descriptive phrases that would
//    need to be cut down later.
// 5. Self-check pass before returning JSON, mirroring the pattern used in
//    generate-ai-content.js — catches product words, the word
//    "Spoonflower," duplicate entries, and malformed hashtags before the
//    result gets cached and reused across every colorway.
// 6. Lightweight code-level safety net (normalizeTrends) that enforces
//    hashtag formatting and de-dupes arrays after JSON.parse, as a
//    backstop the same way enforceCharacterLimits backstops the
//    content-generation file.
//
// === CHANGE LOG (this revision, from the 12-question interview) ===
// 7. Recency tightened from vague "last few months" to an explicit
//    3-6 month window.
// 8. Source weighting: prioritize Pinterest/home-decor-style trend
//    coverage specifically over generic or broader design-world sources.
// 9. No bias toward emerging vs. proven trends — explicitly told to mix
//    both rather than favor one.
// 10. Saturation handling: broad/generic terms (e.g. "boho") are kept,
//     not excluded, but must be paired with 1-2 more specific niche
//     variants rather than filling every slot with generic terms.
// 11. Seasonal/holiday relevance only invoked when it's an obvious fit
//     for the actual design, not applied by default.
// 12. Geographic scope: US-primary, but global/English-language trends
//     are acceptable too, not restricted to US-only.
// 13. Search count explicitly capped at 2 per run (cost-conscious choice
//     after confirming actual web search pricing: ~$0.01-0.03 per search
//     including token cost, run once per design not per colorway).
// 14. Thin-results handling: if a design is genuinely unusual/niche and
//     search turns up weak matches, the model is told to return fewer
//     entries rather than force weak/generic filler just to hit the
//     normal count targets.
// 15. Per-entry freshness/confidence labels considered and explicitly
//     rejected — the model has no real analytics to base that on, it
//     would only be a soft self-assessment, not verified data, and
//     wasn't worth adding on that basis.
//
// === CHANGE LOG (this revision — timeout fix) ===
// 16. FIXED: this function was hitting Netlify's 30s synchronous function
//     timeout in production (confirmed via function log: "Duration: 30000
//     ms"), which kills the invocation before any body is returned. The
//     client then gets a raw HTML/empty timeout response instead of JSON,
//     which is what produced the cryptic "The string did not match the
//     expected pattern" Safari error downstream (that's WebKit's generic
//     message for calling .json() on a non-JSON body).
//     Root cause: this call chains image analysis + up to 2 sequential
//     web searches (search -> read results -> decide to search again ->
//     read again) inside a single synchronous invocation, which has no
//     hard ceiling on how long the model can take.
//     Fix: search cap dropped from 2 to 1. This removes one full
//     search-and-read round trip, which was the single largest variable
//     cost in the call. It reduces trend breadth slightly (one query
//     instead of two triangulating queries) but is the highest-leverage
//     latency cut available without restructuring this into a
//     background function. Prompt and max_uses both updated to match,
//     and the self-check item referencing "no more than 2 searches" is
//     updated to 1.
//     NOTE: this alone does not guarantee the 30s ceiling is never hit
//     (search latency and API load both vary) — the frontend fetch call
//     also now has a client-side timeout and safe JSON parsing as a
//     second layer of defense so a slow call fails with a clear message
//     instead of a cryptic parse error. See index.html change log.

const SYSTEM_PROMPT = `You are a trend research assistant for a surface pattern designer who licenses repeating pattern designs across many product types on Spoonflower, and markets them on Pinterest and Instagram.

You'll be shown one image of a repeating pattern design. First identify its technique, main motif, layout/scale, and overall style. Deliberately ignore its color palette and mood, this research will be cached and reused across every colorway of this same design, so it must stay color/mood blind.

Then use web search to find current, genuinely trending keywords, hashtags, and search phrases relevant to that technique, motif, and style, useful later for Spoonflower listing tags, Pinterest search-style titles, and Instagram hashtags and captions. Prioritize real current search behavior over generic guesses. Run at most 1 search, that's the cap, so spend it well: pick the single query that best covers the core motif and style together rather than splitting across multiple angles.

SOURCE WEIGHTING: when search results give you a choice, weight Pinterest and home-decor/interiors trend coverage over generic design-world sources, that audience overlaps most with this designer's actual buyers.

RECENCY: favor trends that are genuinely active within roughly the last 3 to 6 months over anything that reads as stale, dated, or a past design-world moment that has cooled off. A technically-true but old trend is not useful here.

GEOGRAPHY: default to US market relevance, but current global/English-language trends are also acceptable, this doesn't need to be US-exclusive.

SEASONAL: only lean into an upcoming season or holiday if it's an obvious, natural fit for what's actually in the image (e.g. an unmistakably autumnal motif). Don't force seasonal framing onto a design that doesn't call for it.

SATURATION AND NICHE PAIRING: don't avoid broad, high-volume generic terms (e.g. "boho," "floral") entirely, real search volume there is still valuable, but don't let them fill every slot either. Pair each broad term you use with at least one or two more specific, less saturated niche variants (e.g. alongside "floral," something like "wildflower meadow" or "grandmillennial floral") so the results include both reach and easier-to-rank specificity.

EMERGING VS PROVEN: don't bias toward only just-emerging trends or only already-proven ones, a genuine mix of both is fine and often best.

NO OVERLAP: "keywords", "hashtags", and "searchPhrases" must each add distinct value, do not restate the same concept across two of the three arrays (e.g. don't return both "boho floral" as a keyword and "boho floral pattern ideas" as a search phrase if they'd just duplicate the same signal). Every entry should earn its own slot.

LENGTH: keep "keywords" entries compact, real, commonly-searched terms (favor 2 to 3 word phrases over long descriptive ones), since these get used later as the base for tags with a strict 20 character limit. Long, elaborate phrases just have to get cut down later, so compact and real beats descriptive and long.

HASHTAG FORMAT: every hashtag must be a single token with no internal spaces, starting with #, using camelCase if it's a multi-word concept (e.g. "#bohoFloral", not "#boho floral" or "boho floral").

THIN RESULTS: if this design is genuinely unusual or niche and your search turns up few real matches, it's fine and preferred to return fewer entries in one or more arrays rather than padding with weak, generic, or invented filler just to hit the normal count target. A shorter, honest list beats a full but low-quality one.

Never mention any specific product type (fabric, wallpaper, apparel, curtains, quilting cotton, bedding, etc) or the word "Spoonflower" in anything you return. This research is about the design's motif and style, not the product it eventually gets printed on.

Before returning your answer, silently review it against this checklist and fix anything that fails, then output only the corrected JSON:
1. No product-type words and no "Spoonflower" anywhere in any array or in designSummary.
2. No duplicate or near-duplicate entries within an array or across the three arrays.
3. Every hashtag starts with # and has no internal spaces.
4. designSummary has no color or mood words.
5. No more than 1 search was used.
6. Broad/generic terms, if used, are paired with at least one niche variant rather than dominating a whole array.
7. keywords: up to 12 entries. hashtags: up to 12 entries. searchPhrases: up to 6 entries. Fewer is fine and expected for a thin-match design, do not pad to hit these numbers.
Do not mention this review process in your output.

Return ONLY a single raw JSON object, no markdown, no backticks, no commentary, with exactly these keys:
{
  "designSummary": "one short phrase naming the technique, main motif, and style, no color or mood words",
  "keywords": ["up to 12 trending keyword phrases (fewer is fine for a thin-match design), no product or platform words"],
  "hashtags": ["up to 12 trending hashtag strings (fewer is fine for a thin-match design), include the # symbol, no product or platform words"],
  "searchPhrases": ["up to 6 longer natural search phrases (fewer is fine for a thin-match design), Pinterest/Google style, no product or platform words"]
}`;

// Code-level backstop, mirrors enforceCharacterLimits in
// generate-ai-content.js. Fixes hashtag formatting and removes exact
// duplicates across arrays even if the model's self-check missed
// something. Does not attempt to judge relevance or trend accuracy,
// only structural correctness.
function normalizeHashtag(tag) {
  let t = (tag || "").trim();
  if (!t) return "";
  t = t.replace(/\s+/g, ""); // no internal spaces
  if (!t.startsWith("#")) t = "#" + t;
  return t;
}

function dedupeArray(arr) {
  if (!Array.isArray(arr)) return arr;
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const key = (item || "").toString().trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function normalizeTrends(parsed) {
  if (!parsed) return parsed;
  if (Array.isArray(parsed.hashtags)) {
    parsed.hashtags = dedupeArray(parsed.hashtags.map(normalizeHashtag).filter((t) => t.length > 1));
  }
  if (Array.isArray(parsed.keywords)) {
    parsed.keywords = dedupeArray(parsed.keywords);
  }
  if (Array.isArray(parsed.searchPhrases)) {
    parsed.searchPhrases = dedupeArray(parsed.searchPhrases);
  }
  return parsed;
}

async function callAPI(apiKey, imageBase64, mediaType) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      // Claude Sonnet 5 no longer accepts the temperature parameter at
      // all (even at a normal value) — it returns a 400 if present, so
      // it's omitted entirely rather than set to a specific number.
      // SYSTEM_PROMPT never changes call to call (no dynamic interpolation
      // in it at all), so it's cached with a 1-hour TTL — every call from
      // every user for every design reuses the same cached prefix, not
      // just repeat calls for the same design.
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: "Research trending keywords, hashtags, and search phrases for this design. Return only the JSON object described in your instructions." },
        ],
      }],
      // max_uses hard-caps this at 1 search per call, enforced by the
      // API itself, not just the prompt instruction above. Lowered from
      // 2 to 1 to cut latency and reduce the risk of hitting Netlify's
      // 30s synchronous function timeout (see change log entry 16 at
      // the top of this file).
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || "Anthropic API error");
    err.status = res.status;
    throw err;
  }

  // Responses with web_search contain multiple block types (tool_use,
  // tool_result, text) — never assume content[0] is the text block.
  const textBlock = Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
  const raw = (textBlock?.text || "").replace(/```json|```/g, "").trim();

  try {
    return { parsed: normalizeTrends(JSON.parse(raw)), usage: data.usage };
  } catch (e) {
    e.rawText = raw;
    throw e;
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let imageBase64, mediaType;
  try {
    const body = JSON.parse(event.body || "{}");
    imageBase64 = body.imageBase64;
    mediaType = body.mediaType || "image/jpeg";
    if (!imageBase64 || typeof imageBase64 !== "string") throw new Error("Missing image");
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "API key not configured" }),
    };
  }

  try {
    const { parsed, usage } = await callAPI(apiKey, imageBase64, mediaType);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trends: parsed, usage }),
    };
  } catch (err) {
    // Retry once on a parse failure — self-corrects transient formatting
    // hiccups without the user needing to manually retry.
    if (err.rawText !== undefined) {
      try {
        const retry = await callAPI(apiKey, imageBase64, mediaType);
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trends: retry.parsed, usage: retry.usage }),
        };
      } catch (err2) {
        return {
          statusCode: 502,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: "The AI returned unreadable formatting twice in a row. Try again.",
            rawText: (err2.rawText || "").slice(0, 500),
          }),
        };
      }
    }
    const status = (err.status && err.status >= 400 && err.status < 600) ? err.status : 500;
    const friendly = status === 429 ? "Rate limited by Anthropic, wait a moment and try again."
      : status === 529 ? "Anthropic is overloaded right now, try again shortly."
      : (err.message || "Server error");
    return {
      statusCode: status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: friendly }),
    };
  }
};
