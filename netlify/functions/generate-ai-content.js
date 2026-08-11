// netlify/functions/generate-ai-content.js
//
// Runs per image, per selected platforms. No web_search (uses trends
// already researched and cached by research-trends.js, passed in from
// frontend state). Handles manual keyword input, the color/mood toggle,
// and the shared/colorway-specific tag split.
//
// === CHANGE LOG (this revision) ===
// 1. FIXED: Spoonflower description limit corrected from "~100 words"
//    (500-600+ chars) to the platform's real current limit of 150
//    characters. This was the most important bug — the old prompt was
//    generating descriptions Spoonflower would likely truncate or reject.
// 2. FIXED: Spoonflower "name" (title) limit corrected from an assumed
//    60 chars to the platform's real current limit of 75 chars.
// 3. Verified unchanged (already correct): Spoonflower tags — 13 total,
//    20 chars each. Pinterest title 100 / description 500. Instagram
//    caption 2200 cap with ~125 char fold.
// 4. NEW: CLICHE_RULE — explicit ban on generic AI-marketing phrasing
//    ("elevate your space," "timeless elegance," etc.) that was making
//    output sound generic/off-brand.
// 5. STRENGTHENED: the em dash / dash-as-punctuation rule was already
//    present but evidently still leaking through. Rewrote it with a
//    concrete bad example and folded it into a mandatory self-check.
// 6. NEW: SELF_CHECK_RULE — the model now reviews its own draft against
//    every hard rule (dashes, cliches, product words, all character
//    limits) before returning JSON, instead of relying on rules alone.
// 7. NEW: product-word rule is now split in two. Spoonflower stays
//    fully banned on product/carrier words (unchanged, this is a real
//    platform quirk). Pinterest/Instagram now ALLOW generic
//    product-category words (fabric, wallpaper) when they're part of a
//    naturally-searched phrase, since that costs less reach on those
//    platforms than on Spoonflower.
// 8. NEW: top-level "licensingNote" field — a short, honest flag only
//    when a design reads as unusually strong for brand/licensing
//    pitching, since licensing is an active focus of the business.
// 9. Instagram hashtags now explicitly instructed to mix trend-research
//    hashtags with evergreen ones, rather than leaning all the way to
//    either side.
//
// === CHANGE LOG (this revision) ===
// 10. FIXED: Spoonflower "name" field was leaking commas, which
//     Spoonflower's title field does not allow (confirmed allowed set:
//     hyphen, apostrophe, quotation marks, ampersand, period, plus,
//     slash, percent, parentheses — no comma). Root cause was the
//     global FORMAT_RULE telling the model to "use commas instead of
//     dashes" everywhere, which bled into name/title fields where a
//     comma isn't just stylistically off, it's a rejected character.
//     Added an explicit allowed-character constraint on the Spoonflower
//     name field, plus a code-level strip as a backstop.
// 11. Pinterest title commas are NOT a platform violation (Pinterest
//     allows punctuation in titles), but the same forced-comma-separator
//     habit was making titles read like a spliced list instead of a
//     natural search phrase. Reworded name/title guidance in both
//     fields to build a natural phrase instead of enumerating parts
//     with commas.
// 12. LOOSENED: Spoonflower description guidance no longer pushes to
//     "target 120 to 150" as a near-mandatory range. Description isn't
//     confirmed to be a search-ranking signal on Spoonflower (title and
//     tags are, per their own docs) — it reads more like shopper-facing
//     persuasive copy. Forcing it toward the character ceiling risked
//     reintroducing padding/filler language. Still capped at 150 as a
//     hard limit, but no longer nudged to use nearly all of it if a
//     shorter version already does the job.
//
// === CHANGE LOG (this revision — usage/audience + banned words) ===
// 13. NEW: Spoonflower description guidance now explicitly encourages
//     naming a room/use-case (living room, bedroom, nursery) and/or an
//     audience (girls, boys, unisex, toddlers, baby) where it genuinely
//     fits the design, since this aids buyer discovery and licensing
//     framing. This is DELIBERATELY separate from the existing
//     PRODUCT_WORD_RULE ban: room and audience words are not carrier
//     product types (fabric, wallpaper, etc), so this doesn't reopen
//     that rule, it adds a new encouraged category alongside it.
// 14. NEW: BANNED_WORDS_RULE — the words "repeat"/"repeating" and
//     "pattern"/"patterned" are now banned outright from every field,
//     every platform. Added as its own global rule (not folded into
//     CLICHE_RULE, since these are functional/generic-industry words
//     rather than marketing-speak) and added to the mandatory
//     self-check.
//
// === CHANGE LOG (this revision — no scale/size claims) ===
// 15. NEW: SCALE_CLAIM_RULE — the model can no longer claim an absolute
//     scale or size for the design (e.g. "large scale," "small scale,"
//     "oversized," "mini") anywhere, on any platform. Root cause: the
//     uploaded image is a flat square design file with no size
//     reference in it, so the model has no actual way to know what
//     size this will be sold/printed at, "large scale" was a guess
//     that could contradict how the design is actually listed. The
//     model can still describe arrangement, density, and repeat
//     structure (e.g. "diagonal grid," "tossed," "tightly spaced")
//     since that's visually apparent from the image itself, it's only
//     the absolute size claim that's banned. Spoonflower's sharedTags
//     "layout or scale" tag category is reworded to "layout" only, and
//     the TACOS structure mention is changed to TACO (Scale dropped)
//     to match. Added to the mandatory self-check and to a code-level
//     regex backstop alongside the existing banned-words strip.
//
// === CHANGE LOG (this revision — theme prominence over literal motif) ===
// 16. NEW: THEME_PROMINENCE_RULE — buyers search by aesthetic/theme
//     (botanical, floral, cottagecore, grandmillennial, coastal
//     grandmother, modern farmhouse, boho, etc), not by literal motif
//     nouns (sprig, leaves, vine, branch). Prior output was leading
//     with literal motif words in the name and over-weighting motif
//     tags in sharedTags, which reads accurately but isn't how anyone
//     actually searches on Spoonflower or Pinterest. Reworded the
//     Spoonflower name guidance, the sharedTags category mix (theme
//     tags increased from 1-2 to 3-4 and made the lead category, motif
//     tags reduced from 2-3 to 1-2 and now explicitly described as
//     secondary/minimal), the tag search-behavior priority ordering,
//     the Pinterest title guidance, and the Instagram hashtag guidance,
//     all to lead with and prioritize the theme/aesthetic word over the
//     literal motif word. Motif words aren't banned, just demoted to a
//     supporting detail (at most one or two, never the lead word).
//     Added as its own global rule (not folded into an existing one,
//     since it's a distinct discoverability principle) and added to the
//     mandatory self-check.
//
// NOT changed / deliberately deferred: no per-catalog repetition memory
// (would require persistent storage across generations — a real feature,
// but a phase 2 architecture change, not a prompt change). No multiple
// variants per field — one strong version per field, as requested.

const FORMAT_RULE = `Formatting rule that applies to every field you write, no exceptions: never use a dash as a punctuation mark. This means no em dashes (—) and no hyphen used to stand in for a comma, colon, or period. WRONG example: "bold florals - perfect for spring." RIGHT: "Bold florals. Perfect for spring." Use commas or periods instead, or just start a new sentence. The only dashes allowed anywhere are inside a single genuinely hyphenated compound word (e.g. "hand-drawn," "off-white," "two-tone"). Before you finalize your answer, specifically scan every field for the — character and for a hyphen surrounded by spaces, and rewrite anything you find.`;

const CLICHE_RULE = `Never use generic AI-marketing phrasing, in any field, including close variants of these: "elevate your space/room/wardrobe," "timeless elegance," "effortlessly chic," "perfect for" as a sentence opener, "whether you're... or...," "in today's world" / "in a world where," "seamlessly blends," "a true statement piece," "look no further," "unleash your creativity," "breathe new life into," and "curated" used as a filler adjective. If you catch yourself about to write one of these, stop and replace it with a concrete, specific detail about what's actually in THIS image instead. Generic phrasing that could apply to any pattern design is a failure, specificity is the whole point.`;

const BANNED_WORDS_RULE = `Hard word ban that applies to every field, every platform, no exceptions: never use the words "repeat," "repeating," "pattern," or "patterned" (or any other close variant of these, e.g. "repeats," "patterning"), anywhere in your output, even though these are common industry terms for this kind of design. When you would naturally reach for one of these words, replace it with a concrete alternative appropriate to what you're describing instead, for example: "design," "print," "motif," "layout," or "artwork" for "pattern," and describing the actual repeat structure directly (e.g. "tossed," "all-over," "seamless flow," "continuous") instead of using the word "repeat" as a noun or verb. This is a strict word-choice ban, not a concept ban, the underlying ideas (that it's a repeating surface design) can still come through, just never using these specific words.`;

const SCALE_CLAIM_RULE = `Never make any claim about the design's absolute scale or size, anywhere, on any platform. This means avoiding terms like "large scale," "small scale," "oversized," "mini," "tiny," "extra large," or any similar size-class descriptor, even though these are common industry and shopper search terms. Reason: the uploaded image is a flat square design file with no size reference in it (no ruler, no room context, no object for scale), so there is no way to know what physical size this will actually be printed or sold at, an absolute scale claim would be a guess that could easily contradict how the design is actually listed. You CAN still describe what's visually apparent directly in the image without claiming a size: motif density, spacing, and arrangement are fair game (e.g. "a diagonal grid of hearts on a checked ground," "tightly spaced florals," "loosely scattered dots"), you just can't attach a size-class word like "large" or "mini" to any of it. WRONG: "Buffalo Check Sweetheart Grid with Tossed Hearts Large Scale Layout." RIGHT: "Buffalo Check Sweetheart Grid with Tossed Hearts."`;

const THEME_PROMINENCE_RULE = `Real buyers and shoppers overwhelmingly search by aesthetic or theme (e.g. "botanical," "floral," "cottagecore," "grandmillennial," "coastal grandmother," "modern farmhouse," "boho," "chinoiserie") rather than by literal motif nouns naming the exact object drawn (e.g. "sprig," "leaves," "vine," "branch," "twig"). A literal motif word like "sprig floral" is accurate but is not a real, commonly-typed search query, whereas "botanical" or "cottagecore floral" is. Across every field, on every platform, the theme/aesthetic word should lead and be the most prominent, most search-driving term. Literal motif words are not banned and can still appear for specificity, but keep them secondary and minimal, at most one or two motif words total in any single field, and never let a literal motif word open a name/title or crowd out the theme word. When building a name, title, or tag set, ask "what aesthetic bucket would a shopper actually browse or search for this under" first, and treat the literal motif as a supporting detail added after that.`;

const PRODUCT_WORD_RULE = `CRITICAL RULE FOR SPOONFLOWER CONTENT ONLY: never mention any specific product type (fabric, wallpaper, wallpaper mural, quilting cotton, curtains, apparel, upholstery, bedding, wrapping paper, tea towel, or any other carrier item) anywhere in the "name", "description", "sharedTags", or "colorwayTags" fields, and never use the word "Spoonflower" either. Spoonflower prints this same design across dozens of different product types and doesn't categorize listings by product, so naming one narrows how a buyer or licensing scout pictures the design and adds nothing useful. Describe only the design itself: technique, motif, color, mood, theme, style. NOTE: this ban is specifically on carrier PRODUCT types (what it gets printed on). It does NOT cover room/use-case or audience words, see the usage/audience guidance in the description field instructions below, those are encouraged, not banned.`;

const PRODUCT_WORD_RULE_SOCIAL = `For Pinterest and Instagram fields only (this does not apply to Spoonflower fields, see the rule above): generic product-category words like "fabric," "wallpaper," or "removable wallpaper" ARE allowed when they're a natural part of a real, commonly-searched phrase (e.g. "wallpaper ideas," "fabric print inspo"), since shoppers genuinely search that way on these platforms and banning them costs real reach. Never invent a specific carrier item, use case, or product line that hasn't been confirmed, and never force a product word in in if it doesn't fit naturally into a real search phrase. Still never use the word "Spoonflower" itself in Pinterest or Instagram fields.`;

const TONE_GOAL = `Write for both individual buyers and brands/licensing scouts, both are active parts of this business. Favor concrete, searchable terms over vague adjectives, commercial versatility should read clearly. Optimize purely for what will actually drive views, saves, and sales, not for a particular personal tone.`;

const TAG_LENGTH_RULE = `Hard constraint on every single tag in "sharedTags" and "colorwayTags": each tag must be 20 characters or fewer, including spaces. This is a strict Spoonflower platform limit, not a guideline. If a concept naturally needs more than 20 characters, shorten it to the closest real, still-searched shopper term rather than a long descriptive phrase.`;

const TAG_SEARCH_BEHAVIOR_RULE = `Tag sourcing priority, follow in this order:
1. First, pull directly from the cached trend research keywords and search phrases provided below, wherever they genuinely match what's in this image. These came from live web search on real current buyer and shopper behavior, they are the highest-value tags available to you and the whole reason trend research was run, do not waste them.
2. Only where the trend research doesn't fully cover a tag slot (e.g. no trending term fits a required category like layout/scale or a colorway mood tag), fall back to your own judgment of what a real buyer or licensing scout would actually type into Spoonflower's or Google's search bar, not a designer's internal or poetic phrase.
3. In both cases, favor common two-to-three word compound search terms people actually search often (e.g. "floral wallpaper," "boho print," "ditsy floral") over invented or overly specific mashups (e.g. avoid stitching multiple style words together into a phrase no one searches, like "linear-brush-motif"). When in doubt, choose the more commonly searched, simpler term over the more precise-sounding invented one.
4. Theme/aesthetic terms (see the theme prominence rule above) should be treated as higher-value, higher-priority tag slots than literal motif nouns, since they're what buyers actually search. When a tag slot could go either way, default to the theme/aesthetic word.
The goal is maximum discoverability and exposure to real shopper search traffic, not maximum descriptive precision. Do not let trend keywords/hashtags bleed word-for-word into "name" or "description", those two fields have their own separate rules above, tags are where the trend data should actually get used.`;

const LICENSING_FLAG_RULE = `Also always include one additional top-level field, "licensingNote" (a plain string, not nested in any platform object). This is separate from and sits alongside the platform objects in the final JSON. Only write a real note (max ~25 words) if this specific design reads as unusually strong for pitching to brands or licensing scouts, for example an especially clean tight repeat, a bold scale, or strong alignment with a current real trend from the research below. If the design is solid but not a standout licensing candidate, return an empty string "" for this field rather than forcing a note, most designs should get an empty string here. Be honest and selective, this flag is only useful if it's rare.`;

const SELF_CHECK_RULE = `Before you output the final JSON, silently review every field you drafted against this checklist and correct anything that fails, then output only the corrected JSON (do not mention this review process in your output, do not show your draft):
1. No em dashes and no hyphens used as punctuation anywhere (hyphenated compound words like "hand-drawn" are fine).
2. No banned cliche phrases or close variants of them, in any field.
3. No product-type words or the word "Spoonflower" anywhere in the spoonflower "name", "description", "sharedTags", or "colorwayTags".
4. Every Spoonflower tag is 20 characters or fewer. "sharedTags" has exactly 8 entries, "colorwayTags" has exactly 5.
5. Spoonflower "name" is 75 characters or fewer (target 60 to 75). Spoonflower "description" is 150 characters or fewer.
6. Pinterest "title" is 100 characters or fewer. Pinterest "description" is 500 characters or fewer (target 150 to 300).
7. Instagram "caption" reads naturally within roughly the first 125 characters before the hook completes, and the full caption is well under the 2200 character hard cap. "hashtags" has 8 to 15 entries.
8. Nothing in any field contradicts another field (e.g. a color named in one place that doesn't match another).
9. The words "repeat," "repeating," "pattern," and "patterned" (and close variants) do not appear anywhere, in any field, on any platform.
10. Where a Spoonflower description was written, check whether it named a room/use-case or an audience where one genuinely fit the design, per the usage/audience guidance below, add one in if it's a natural fit and was missed.
11. No scale or size claim (e.g. "large scale," "small scale," "oversized," "mini," "tiny," "extra large") appears anywhere, in any field, on any platform, including inside "name" and inside any tag.
12. In "name"/"title" fields and in "sharedTags", check that a theme/aesthetic word (e.g. botanical, floral, cottagecore, grandmillennial) leads or is at least as prominent as any literal motif noun (e.g. sprig, leaves, vine), and that literal motif words number no more than one or two total per field. If a literal motif word is doing the work a theme word should be doing, swap or reorder it.
If any check fails, silently fix it before returning, do not just note the problem.`;

function buildTrendBlock(trends) {
  if (!trends) return "";
  const kw = Array.isArray(trends.keywords) ? trends.keywords.join(", ") : "";
  const ht = Array.isArray(trends.hashtags) ? trends.hashtags.join(", ") : "";
  const sp = Array.isArray(trends.searchPhrases) ? trends.searchPhrases.join(", ") : "";
  return `

Cached trend research for this design (reusable across every colorway, deliberately color/mood blind, already excludes product and platform words):
Trending keywords: ${kw || "none found"}
Trending hashtags: ${ht || "none found"}
Trending search phrases: ${sp || "none found"}
Draw on these only where they genuinely fit what you see in THIS image. Never force a mismatched one in just because it's on the list. Note: if any trend term itself contains a banned word (see the word ban rule above), do not carry that word over, use the rest of the concept and rephrase around it.`;
}

function buildManualKeywordBlock(manualKeywords) {
  if (!manualKeywords || !manualKeywords.trim()) return "";
  return `

The designer supplied these keyword or phrase leads herself: "${manualKeywords.trim()}"
Use them only where they genuinely and naturally fit this image. Never force a mismatched one in just because it was supplied.`;
}

const SPOONFLOWER_NAME_CHARSET_RULE = `Spoonflower's title field only accepts letters, numbers, spaces, and these special characters: hyphen (-), apostrophe ('), quotation marks ("), ampersand (&), period (.), plus (+), slash (/), percent (%), and parentheses. NO COMMAS, and no other punctuation, anywhere in "name". Build the name as one natural flowing phrase (e.g. "Hand Drawn Boho Floral in Sage Green"), not a comma-separated list of parts (never "Hand Drawn Boho Floral, Sage Green"). This applies even though the general formatting rule elsewhere in this prompt says to use commas instead of dashes, that substitution rule does not apply inside "name", commas are not a safe substitute there, they're a rejected character.`;

const SPOONFLOWER_USAGE_AUDIENCE_RULE = `USAGE AND AUDIENCE GUIDANCE FOR "description": where it genuinely and naturally fits what's actually in this image (never force it onto a design it doesn't suit), work in a room/use-case and/or an audience descriptor, since these are real things buyers and licensing scouts search and filter by. Examples of room/use-case words: living room, bedroom, nursery, kids room, playroom, bathroom. Examples of audience words: girls, boys, unisex, toddlers, baby, kids, adults. Only include these if the design's actual scale, motif, and mood genuinely reads that way, a bold tropical leaf print might suit "living room," a small-scale bunny motif might suit "nursery" or "baby," and plenty of designs (an abstract geometric, a sophisticated floral) suit neither and should just skip this entirely rather than force a mismatched audience or room onto them. Note this is separate from the carrier product-type ban above, "living room" or "girls" are not product types, they're allowed and encouraged where they fit.`;

function spoonflowerBlock(includeColorMood) {
  const nameGuidance = includeColorMood
    ? `"name": Theme/Aesthetic + Style + Color, written as one natural phrase, not comma-separated parts. Lead with the theme/aesthetic word (see the theme prominence rule above, e.g. "Botanical," "Cottagecore," "Grandmillennial") rather than a literal motif noun, a literal motif word can appear later in the phrase as a supporting detail but should never be the lead word and should never number more than one or two. Spoonflower's real title limit is 75 characters, use close to that budget (aim for 60 to 75 characters). Include the theme, the technique or style, and this colorway's actual color in plain, concrete color language (e.g. "sage green," never just "green"). Because color differs per image, this means the name will differ across colorways of the same design.`
    : `"name": Theme/Aesthetic + Style + Theme/Layout descriptor, written as one natural phrase, not comma-separated parts. Lead with the theme/aesthetic word (see the theme prominence rule above, e.g. "Botanical," "Cottagecore," "Grandmillennial") rather than a literal motif noun, a literal motif word can appear later in the phrase as a supporting detail but should never be the lead word and should never number more than one or two. Spoonflower's real title limit is 75 characters, use close to that budget (aim for 60 to 75 characters) by including the theme, the technique or style, AND a layout or arrangement descriptor, never color or mood. Do not stop short just because color is excluded, use the freed-up characters for other genuinely descriptive, searchable words about the design itself. Because no color is included, this means the name will be identical across every colorway of this design.`;

  return `
SPOONFLOWER (the "Naming Assistant" rules, follow exactly):
Return a "spoonflower" object with:
- ${nameGuidance}
${SPOONFLOWER_NAME_CHARSET_RULE}
- "description": Spoonflower's real description field limit is 150 characters, this is a hard platform cap, so stay AT OR UNDER 150 characters total including spaces. Spoonflower's own guidance treats title and tags, not description, as the fields their search engine actually uses, so description is shopper-facing persuasive copy, not a keyword-stuffing opportunity. Use as much of that 150 character budget as genuinely earns its place, mentioning the theme/aesthetic, the technique, and the overall mood, but do not pad with filler words just to get closer to the limit. A shorter description that reads cleanly and does its job is better than a longer one stretched to fill space. Always stay fully generic on color and mood here regardless of the toggle above, never name a specific color or mood word, so this exact same description text works identically across every colorway of this design. Do not mention any product type, see the product word rule above, focus entirely on the pattern itself. ${SPOONFLOWER_USAGE_AUDIENCE_RULE}
- "sharedTags": an array of exactly 8 lowercase tags, reusable across every colorway of this design. Lead with theme/aesthetic first, per the theme prominence rule above: 3 to 4 theme/aesthetic tags (the primary discovery driver, e.g. "botanical," "cottagecore," "grandmillennial," "coastal grandma"), then 1 to 2 literal motif tags kept minimal and secondary (the literal object drawn, e.g. "sprig," "leaf"), then 1 to 2 layout/arrangement tags (composition only, e.g. "tossed floral," "diagonal grid," "linear stripe," never a scale or size claim like "large scale" or "mini," see the scale rule above), then 1 to 2 style tags. Total must equal exactly 8, and theme/aesthetic tags should never be outnumbered by literal motif tags.
- "colorwayTags": an array of exactly 5 lowercase tags, unique to this specific colorway (color and mood, reflecting this image's actual look and feel): 3 concrete color name tags (specific names, e.g. "dusty rose," never just "pink"), 2 mood tags.
${TAG_LENGTH_RULE}
${TAG_SEARCH_BEHAVIOR_RULE}
Together sharedTags and colorwayTags total exactly 13 tags, following the TACO (Theme, Audience, Color, Object) structure overall, deliberately without a Scale element since absolute size can't be judged from the uploaded image, see the scale rule above. Theme leads that structure for a reason, see the theme prominence rule. No word in any tag may repeat a word already used in "name". Specific color names required throughout, never a bare color word alone.`;
}

const PINTEREST_BLOCK = `
PINTEREST:
Search behavior to write for: long-tail, Google-like search behavior, front-loaded natural phrases, seasonal/use-case terms when accurate. This reflects general platform search behavior, not live trend data.
Return a "pinterest" object with:
- "title": max 100 characters (Pinterest's real hard limit). Pinterest titles work like search queries, so front load the single most specific, searchable phrase. Per the theme prominence rule above, that front-loaded phrase should center on the theme/aesthetic word (e.g. "Cottagecore Botanical," "Grandmillennial Floral") rather than a literal motif noun, a motif word can follow as a supporting detail but shouldn't open the title or dominate it. No clickbait.
- "description": max 500 characters (Pinterest's real hard limit), written closer to 150 to 300 characters for readability, since only the first 50 to 60 characters show before the fold, and that opening needs to carry the strongest keyword phrase, which per the theme prominence rule should be the theme/aesthetic term. Reflect this image's actual color and mood. Describe what the design is and who it's for. Include one soft call to action. Avoid ALL CAPS and excessive exclamation points.
- "altText": a plain, literal description of what is actually in the image, written for accessibility and a distinct search signal, not a marketing line. Literal motif words belong here even if they're kept minimal elsewhere, accessibility text should describe what's actually visible.
${PRODUCT_WORD_RULE_SOCIAL}
{{PINTEREST_LINK_INSTRUCTION}}`;

const INSTAGRAM_BLOCK = `
INSTAGRAM:
Search behavior to write for: hashtag plus caption keyword combo discovery, a three-tier hashtag mix (broad, mid-niche, small specific). This reflects general platform search behavior, not live trend data.
Return an "instagram" object with:
- "caption": a short hook as the first line, since Instagram truncates captions after about 125 characters, followed by 2 to 4 short lines of body copy. Stay well under Instagram's 2200 character hard cap. Sound like a person talking, conversational not salesy, plain language, reflect this image's actual color and mood, one clear call to action at the end, not three. You may add a short second, licensing-facing line (e.g. "DM for licensing inquiries") if it fits naturally.
- "hashtags": an array of 8 to 15 hashtag strings (include the # symbol), a three-tier mix of broad, mid-niche, and small specific tags. Per the theme prominence rule above, weight this mix toward theme/aesthetic hashtags (e.g. "#cottagecore," "#grandmillennial," "#botanicalprint") over literal motif hashtags (e.g. "#leafprint," "#sprigfloral"), motif hashtags can appear but should be the minority of the set. Blend in relevant hashtags from the trend research below where they genuinely fit, but don't make the whole set trend-only, balance them with evergreen broad and mid-niche tags too so reach doesn't depend entirely on one moment's trends.
- "altText": a plain, literal description of what is actually in the image, for accessibility. Literal motif words belong here even if they're kept minimal elsewhere, accessibility text should describe what's actually visible.
${PRODUCT_WORD_RULE_SOCIAL}
{{INSTAGRAM_LINK_INSTRUCTION}}`;

function buildSystemPrompt(platforms, links, opts) {
  const { includeColorMood, trends, manualKeywords } = opts;

  let prompt = `You are a visual merchandising copywriter for a surface pattern designer who licenses repeating pattern designs across many product types, sold to both individual buyers and brands/licensing scouts. You will be shown one image of a pattern design. Analyze it directly (technique, motifs, colors, layout, mood) and use that analysis to write listing content. Do not ask the user anything, do not invent a keyword prompt, work only from what you see in the image.

${TONE_GOAL}

${FORMAT_RULE}

${CLICHE_RULE}

${BANNED_WORDS_RULE}

${SCALE_CLAIM_RULE}

${THEME_PROMINENCE_RULE}

${PRODUCT_WORD_RULE}${buildTrendBlock(trends)}${buildManualKeywordBlock(manualKeywords)}

${LICENSING_FLAG_RULE}

Write content for the following sections only, and return ONLY a single raw JSON object with exactly these top level keys (no markdown, no backticks, no commentary):
{ ${platforms.map((p) => `"${p}": {...}`).join(", ")}, "licensingNote": "..." }
`;

  if (platforms.includes("spoonflower")) prompt += `\n${spoonflowerBlock(includeColorMood)}\n`;

  if (platforms.includes("pinterest")) {
    const linkInstruction = links.pinterest
      ? `A destination link was provided: ${links.pinterest}. Do not put the raw URL inside "description", instead work a natural soft call to action around visiting the link into the description's final sentence, and also return it unchanged in a "pinLink" field on the pinterest object.`
      : `No destination link was provided, omit any "pinLink" field.`;
    prompt += `\n${PINTEREST_BLOCK.replace("{{PINTEREST_LINK_INSTRUCTION}}", linkInstruction)}\n`;
  }

  if (platforms.includes("instagram")) {
    const linkInstruction = links.instagram
      ? `A "link in bio" destination was provided: ${links.instagram}. Reference it naturally in the caption's call to action (e.g. "link in bio"), do not paste the raw URL into the caption, and also return the link unchanged in a "bioLink" field on the instagram object.`
      : `No link was provided, omit any "bioLink" field.`;
    prompt += `\n${INSTAGRAM_BLOCK.replace("{{INSTAGRAM_LINK_INSTRUCTION}}", linkInstruction)}\n`;
  }

  prompt += `\n${SELF_CHECK_RULE}\n`;

  return prompt;
}

// Truncates a tag to fit within maxLen, but only at a word boundary —
// never cuts a word mid-way. If even the first word alone exceeds
// maxLen (rare, e.g. one long compound term with no spaces), falls
// back to a hard cut rather than returning an empty tag.
function truncateToWordBoundary(tag, maxLen) {
  const trimmed = (tag || "").trim();
  if (trimmed.length <= maxLen) return trimmed;

  const words = trimmed.split(/\s+/);
  let result = "";

  for (const word of words) {
    const candidate = result ? result + " " + word : word;
    if (candidate.length > maxLen) break;
    result = candidate;
  }

  if (!result) return trimmed.slice(0, maxLen).trim();

  return result;
}

// Code-level backstop for the banned-words rule. Catches "repeat(ing)"
// and "pattern(ed)" (whole-word, case-insensitive) if the model still
// lets one slip through despite the prompt rule and self-check. Applied
// to every string field across every platform after JSON.parse, before
// the result ever reaches the frontend. This is a blunt regex removal,
// not a rewrite, so it can leave a slightly awkward gap behind — that's
// an acceptable tradeoff for a hard guarantee the word never appears,
// versus silently trusting the model 100% of the time.
const BANNED_WORDS_REGEX = /\b(repeats?|repeating|patterns?|patterned)\b/gi;

// Backstop for the scale/size-claim rule. Deliberately targeted at
// explicit size-class phrases rather than every possible size-adjacent
// word (e.g. plain "mini" alone is left alone, since it's common enough
// in non-scale contexts that blanket-stripping it risks mangling
// unrelated text) — this catches the clear, unambiguous violations the
// prompt rule is aimed at without over-stripping.
const SCALE_CLAIM_REGEX = /\b(large[- ]scale|small[- ]scale|mini[- ]scale|extra[- ]large|oversized|large[- ]repeat|small[- ]repeat)\b/gi;

function stripBannedWords(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(BANNED_WORDS_REGEX, "")
    .replace(SCALE_CLAIM_REGEX, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
}

function stripBannedWordsDeep(node) {
  if (typeof node === "string") return stripBannedWords(node);
  if (Array.isArray(node)) return node.map(stripBannedWordsDeep);
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node)) out[key] = stripBannedWordsDeep(node[key]);
    return out;
  }
  return node;
}

// Safety net in case the model still returns an over-limit field despite
// the prompt instructions and self-check. Runs after JSON.parse, before
// the result ever reaches the frontend. Now also catches the corrected
// Spoonflower name (75) and description (150) limits, and Pinterest's
// title (100) and description (500) limits, not just tags. Banned-word
// stripping runs first so truncation limits are measured against the
// already-cleaned text.
function enforceCharacterLimits(parsed) {
  parsed = stripBannedWordsDeep(parsed);

  if (parsed && parsed.spoonflower) {
    ["sharedTags", "colorwayTags"].forEach((key) => {
      if (Array.isArray(parsed.spoonflower[key])) {
        parsed.spoonflower[key] = parsed.spoonflower[key]
          .map((t) => truncateToWordBoundary(t, 20))
          .filter((t) => t.length > 0);
      }
    });
    if (typeof parsed.spoonflower.name === "string") {
      parsed.spoonflower.name = truncateToWordBoundary(parsed.spoonflower.name, 75);
    }
    if (typeof parsed.spoonflower.description === "string") {
      parsed.spoonflower.description = truncateToWordBoundary(parsed.spoonflower.description, 150);
    }
  }
  if (parsed && parsed.pinterest) {
    if (typeof parsed.pinterest.title === "string") {
      parsed.pinterest.title = truncateToWordBoundary(parsed.pinterest.title, 100);
    }
    if (typeof parsed.pinterest.description === "string") {
      parsed.pinterest.description = truncateToWordBoundary(parsed.pinterest.description, 500);
    }
  }
  if (parsed && parsed.instagram && typeof parsed.instagram.caption === "string") {
    parsed.instagram.caption = truncateToWordBoundary(parsed.instagram.caption, 2200);
  }
  return parsed;
}

async function callAPI(apiKey, imageBase64, mediaType, platforms, links, opts) {
  const systemPrompt = buildSystemPrompt(platforms, links, opts);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      // Claude Sonnet 5 no longer accepts the temperature parameter at
      // all (even at a normal value) — it returns a 400 if present, so
      // it's omitted entirely rather than set to a specific number.
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: `Analyze this pattern image and generate the requested sections: ${platforms.join(", ")}. Return only the JSON object described in your instructions.` },
        ],
      }],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || "Anthropic API error");
    err.status = res.status;
    throw err;
  }

  // Never assume content[0] is the text block.
  const textBlock = Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
  const raw = (textBlock?.text || "").replace(/```json|```/g, "").trim();

  try {
    return { parsed: enforceCharacterLimits(JSON.parse(raw)), usage: data.usage };
  } catch (e) {
    e.rawText = raw;
    throw e;
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let imageBase64, mediaType, platforms, links, includeColorMood, trends, manualKeywords;
  try {
    const body = JSON.parse(event.body || "{}");
    ({ imageBase64, mediaType, platforms, links, includeColorMood, trends, manualKeywords } = body);
    if (!imageBase64 || typeof imageBase64 !== "string") throw new Error("Missing image");
    if (!Array.isArray(platforms) || platforms.length === 0) throw new Error("Missing platforms");
    const allowed = new Set(["spoonflower", "pinterest", "instagram"]);
    if (!platforms.every((p) => allowed.has(p))) throw new Error("Invalid platform");
    mediaType = mediaType || "image/jpeg";
    links = links || {};
    includeColorMood = !!includeColorMood;
    trends = trends || null;
    manualKeywords = typeof manualKeywords === "string" ? manualKeywords : "";
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

  const opts = { includeColorMood, trends, manualKeywords };

  try {
    const { parsed, usage } = await callAPI(apiKey, imageBase64, mediaType, platforms, links, opts);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ results: parsed, usage }),
    };
  } catch (err) {
    // Retry once on a parse failure — self-corrects transient formatting
    // hiccups without the user needing to manually retry.
    if (err.rawText !== undefined) {
      try {
        const retry = await callAPI(apiKey, imageBase64, mediaType, platforms, links, opts);
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ results: retry.parsed, usage: retry.usage }),
        };
      } catch (err2) {
        return {
          statusCode: 502,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: "The AI returned unreadable formatting twice in a row. Try generating again.",
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
