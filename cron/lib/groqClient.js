/**
 * Groq Vision client for X-Automation pipelines.
 * Uses qwen/qwen3.6-27b vision model to generate tweets from Reddit posts.
 * Can see actual images — unlike MiMo which is text-only.
 * 
 * Fallback chain: MiMo → Groq Vision → Groq Text → Raw title
 */

import { createKeyManager } from './keyManager.js';
import { stripMarkdown, stripMentions, fixStaleModelNames, isLikelyEnglish, isAIPromptText, isQualityFallbackTitle } from './utils.js';
import { smartTrimToTarget, TWEET_TARGET_CHARS } from '../tweetLimits.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'qwen/qwen3.6-27b';

// Minimum acceptable caption length — anything shorter is a truncated/thin output
// (added Aug 7 after a flat 59-char raw title and a 47-char queued caption went live).
const MIN_TWEET_LENGTH = 60;

// ─── Groq Key Manager ────────────────────────────────────────────────────────

let groqKeys = null;

export function initGroqKeys() {
  groqKeys = createKeyManager('GROQ', [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ]);
  return groqKeys;
}

export function getGroqKeyStatus() {
  return groqKeys?.getStatus() || null;
}

// ─── Build Tweet Prompt ──────────────────────────────────────────────────────

function buildTweetPrompt(redditPost, isVideo = false) {
  const today = new Date().toISOString().split('T')[0];
  
  const videoContext = isVideo 
    ? '\nThis is a VIDEO/DEMO post. Reference the visual content in your tweet.'
    : '';

  // Detect source type
  const isHN = redditPost.subreddit === 'HackerNews' || redditPost.source === 'hackernews';
  const isDevTo = redditPost.subreddit === 'Dev.to' || redditPost.source === 'devto';
  const isReddit = !isHN && !isDevTo;
  
  // Source-specific context
  let sourceContext = '';
  if (isHN) {
    sourceContext = '\nThis is from Hacker News — a tech news site. Summarize the key insight in a viral way.';
  } else if (isDevTo) {
    sourceContext = '\nThis is from Dev.to — a developer community. Summarize the article in an engaging way.';
  }

  const visualContext = redditPost.visualBrief
    ? `\nVISUAL BREAKDOWN (generated from the attached image; use only these observable details):\n${redditPost.visualBrief}`
    : '';

  // Hook formulas for engaging tweets
  const hooks = [
    'Start with a BOLD claim that makes people stop scrolling',
    'Ask a provocative question that sparks debate',
    'Share a surprising stat or fact',
    'Make a prediction about the future',
    'Challenge conventional wisdom',
  ];
  const hook = hooks[Math.floor(Math.random() * hooks.length)];

  return `You are @M_jawad_yasin, an AI Engineering expert on X (Twitter) with 50K+ followers.

CURRENT DATE: ${today}

TASK: Write ONE tweet about the post below. Output ONLY the tweet text.

HOOK STYLE: ${hook}

CAPTION STRUCTURE — follow this 3-part formula in ONE flowing tweet (no line breaks):
1. HOOK — a stop-scroll opening line: bold claim, shocking stat, provocative question, or bold prediction (60-100 chars)
2. BODY — one clear sentence: WHAT the post is and WHY it matters (60-100 chars)
3. CTA — a short closing nudge to engage: "Try it", "This changes everything", "Thoughts?" (10-40 chars)

EMOJI RULE — start the tweet with EXACTLY ONE relevant emoji that matches the post INTENT, then a space, then your hook. Pick by intent:
- AI model/news/release → ⚡ or 🤖 or 🚀
- Tool/software/tutorial → 🛠️ or 💡 or ✨
- Prediction/future → 🔮 or 📈
- Debate/controversy → 💥 or ⚠️
- Data/chart/benchmark → 📊 or 🏆
- Image/art/design → 🎨 or 🖼️
Then continue with HOOK → BODY → CTA in one flowing tweet. Use NO other emojis in the rest of the tweet (a single trailing emoji in the CTA is allowed if it fits naturally).

TWEET RULES:
- MAX 240 characters (hard limit — MUST fit within X's 280-character free plan)
- IMPORTANT: If the post title is NOT in English, first TRANSLATE the full meaning into English, then write the tweet. Output must be 100% English.
- Write in VIRAL, ENGAGING tone — make people want to reply
- Be CONVERSATIONAL, like talking to a friend
- Use simple language, avoid jargon
- If it's news, make it sound exciting
- If it's a tool, make people want to try it
- If it's a debate, take a side
- NO hashtags, NO markdown
- NO "Thread:" or "1/" prefixes
- NO "Here's a tweet:" or similar prefixes
- NEVER include labels like "Hook:", "BODY:", "CTA:" or notes like "(62 chars)" or "A bit of a stretch" in your output — output ONLY the finished tweet text, nothing else
- Just the tweet text, nothing else

POST TO TWEET ABOUT:
Title: ${redditPost.title || 'N/A'}
Source: ${isHN ? 'Hacker News' : isDevTo ? 'Dev.to' : 'r/' + (redditPost.subreddit || 'unknown')}
Upvotes: ${redditPost.upvotes || 0}
Description: ${(redditPost.selftext || '').substring(0, 600)}${sourceContext}${videoContext}${visualContext}

TWEET:`;
}

// ─── Clean Up Generated Text ─────────────────────────────────────────────────

export function cleanTweetText(text) {
  if (!text) return null;
  
  // Step 1: Remove thinking tags (qwen3.6-27b uses <think>...</think>)
  // Try to extract text AFTER </think> first
  const afterThinkMatch = text.match(new RegExp('<\/think>\\s*([\\s\\S]+)$'));
  if (afterThinkMatch && afterThinkMatch[1].trim().length > 10) {
    text = afterThinkMatch[1].trim();
  } else if (
    text.includes('<think>') || 
    text.includes('thinking process') || 
    text.includes('Thinking Process') ||
    text.startsWith('Here') ||
    text.startsWith('The user') ||
    text.startsWith('This is') ||
    text.startsWith('Let me') ||
    text.startsWith('I need') ||
    text.startsWith('Looking at')
  ) {
    // No closing tag or text after is too short
    // Extract the LAST line that looks like a tweet (20-280 chars, no thinking labels)
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const tweetLines = lines.filter(l => {
      const lower = l.toLowerCase();
      // Skip thinking/reasoning lines
      if (lower.startsWith('<think>') || lower.startsWith('thinking') || lower.startsWith('here')) return false;
      if (lower.startsWith('1.') || lower.startsWith('2.') || lower.startsWith('3.')) return false;
      if (lower.startsWith('*') || lower.startsWith('-') || lower.startsWith('final')) return false;
      if (lower.startsWith('option') || lower.startsWith('note:') || lower.startsWith('output:')) return false;
      if (lower.startsWith('the ') || lower.startsWith('this ') || lower.startsWith('let ')) return false;
      if (lower.startsWith('analysis') || lower.startsWith('request') || lower.startsWith('persona')) return false;
      if (lower.startsWith('task:') || lower.startsWith('rule') || lower.startsWith('step')) return false;
      if (lower.startsWith('process') || lower.startsWith('thinking process')) return false;
      // Must be tweet-like length
      return l.length >= 20 && l.length <= 280;
    });
    text = tweetLines.pop() || lines[lines.length - 1] || '';
  }
  
  // Step 2: Clean up text
  text = text.replace(/^["']|["']$/g, '');
  text = text.replace(/#[\w]+/g, '');
  text = stripMarkdown(text);
  text = stripMentions(text);
  text = fixStaleModelNames(text);
  text = text.trim();
  
  // Step 2b: Enforce the 240-char target — smart-trim, never reject, so scraped
  // content is not wasted. Cuts at the last sentence/line/word boundary within
  // the target (audit Aug 18: 72 posts slipped past the prompt-only 240 limit).
  if (text.length > TWEET_TARGET_CHARS) {
    const before = text.length;
    text = smartTrimToTarget(text);
    console.log(`  ✂ Trimmed ${before} → ${text.length} chars (target ${TWEET_TARGET_CHARS})`);
  }

  // Step 3: Validate — must look like a tweet
  if (text.length < 25) {
    return null;  // Too short (truncated/incomplete)
  }

  // Step 3a: Language guard — reject clearly non-English output.
  // Prompts already instruct translation to English; this is a safety net.
  if (!isLikelyEnglish(text)) {
    console.warn('  ⚠ Non-English tweet detected — skipping');
    return null;
  }

  // Step 3b: Check if text is still thinking/reasoning/instructions (not a real tweet)
  const lowerText = text.toLowerCase();
  const garbagePatterns = [
    // Thinking/reasoning patterns
    'thinking process', 'here is', 'the user', 'this is a', 'let me',
    'i need to', 'looking at', 'analysis', 'persona', 'task:',
    'step 1', 'step 2', 'option 1', 'option 2', 'final answer',
    "here's a", 'here s a', 'here is a', 'so the',
    // Instruction/reminder patterns (LLM outputting rules instead of tweet)
    'no hashtags', 'no emojis', 'no markdown', 'no thread',
    'remember,', 'note:', 'output:', 'tweeet:', 'tweet:',
    // Garbage fragments
    'then there', 'by 2028,', 'by 2025,', 'by 2030,',
    'as an ai', 'as a language', 'i cannot', 'i can\'t',
    // Meta-commentary
    'this tweet', 'the tweet', 'my tweet', 'your tweet',
    // PROMPT LEAK PATTERNS (added after live incidents Jul 30)
    'news/tool', 'post content:', 'hook style:', 'tweet rules:',
    'rewrite rules:', 'comment rules:', 'no prefixes', 'thread rules:',
    'your comment:',
    // CAPTION LABEL LEAKS (added after live incident Aug 7 — MiMo emitted "Hook: ... (62 chars) - A bit of a stretch")
    'hook:', 'body:', 'cta:', 'hook —', 'caption structure:',
    'a bit of a stretch', 'fits the prediction style', 'fits the style',
    '(62 chars)', '(',  'chars)', 'prediction style', 'stop-scroll',
    'bold claim', 'shocking stat', 'provocative question', 'bold prediction',
    // EMOJI/STYLE SELECTION LEAKS (added Aug 7 — MiMo emitted "Selection: ⚠️ feels more cautionary, 💥 feels more provocative...")
    'selection:', 'the prompt asks',
    // META-INSTRUCTION ECHOES (added after live incident Aug 7 — Groq Vision emitted "Explain the issue: ...")
    'explain the issue:', 'explain the problem:', 'explain:',
    'describe the image:', 'describe:', 'analyze:', 'summarize:', 'rewrite:',
  ];
  for (const pattern of garbagePatterns) {
    if (lowerText.startsWith(pattern)) {
      console.warn(`  ⚠ Garbage pattern detected: "${pattern}"`);
      return null;
    }
  }

  // Step 3b-1: Structured-label leaks (MiMo emits field labels / numbered
  // reasoning / meta-descriptions instead of a real tweet — new shapes seen
  // Aug 8-10: "5. Emoji: ...", "Intent: ...", "Content: ...", "The post is a
  // screenshot of ..."). A fixed pattern list is whack-a-mole, so catch the
  // common DNA: "N. Field:" numbered prefixes, "Field:" labels, and
  // image/meta descriptions.
  const structuredLabelLeaks = [
    /^\d+\.\s*(emoji|content|hook|body|cta|intent|tone|style|rewrite|translate|title|char\s*(limit|count|s)?)\s*:/i,
    /^(intent|content|emoji|hook|body|cta|tone|style|char\s*(limit|count|s)?)\s*:/i,
    /^(the post is|this post (is|shows|contains)|this is a screenshot of|this is likely about|this image shows|the image shows)\b/i,
  ];
  if (structuredLabelLeaks.some(re => re.test(lowerText))) {
    console.warn('  ⚠ Structured label leak detected (numbered/field/meta) — rejecting');
    return null;
  }

  // Step 3b-2: Check for prompt leak patterns ANYWHERE in text
  const promptLeaks = [
    'news/tool/debate handling',
    'hook style: start with',
    'tweet rules: max 240',
    'rewrite rules: max 240',
    'comment rules: max 240',
    'no prefixes like',
    'just the tweet text, nothing else',
    'just the rewritten tweet, nothing else',
    'just the comment text, nothing else',
    'output only the tweet',
    // CAPTION-ANNOTATION LEAKS (added Aug 7 — "(60 chars) - Good." and emoji reasoning)
    'chars)', 'is best.', ' - good.', 'the debate aspect',
    'feels more cautionary', 'feels more provocative',
    // STRUCTURED-LABEL ECHOES (added Aug 10 — "7. Content: Translate title if needed",
    // "5. Emoji: ... 🛠️ or 💡 fits best. I'll use 🛠️.", "Intent: ... This is likely about ...")
    'translate title if needed', 'this is likely about', 'fits best', 'no translation needed',
  ];
  for (const leak of promptLeaks) {
    if (lowerText.includes(leak)) {
      console.warn();
      return null;
    }
  }
  // Step 3c: Check for incomplete/truncated sentences
  const lastChar = text.slice(-1);
  const endsClean = ['.', '!', '?', '"', "'", '…', '—'].includes(lastChar);
  // Even when ending with punctuation, reject a dangling sentence-completing
  // verb as the final word (live catch Aug 10: "...the "Delete" button looks."
  // — the verb demands an object/complement, so the sentence was cut).
  const danglingVerb = /\b(looks|looked|seems|seemed|feels|felt|appears|appeared|sounds|sounded|turns|turned|becomes|became|makes|made|gets|got|gives|gave|shows|showed|wants|wanted|needs|needed|tries|tried|starts|started|continues|continued)\s*[.!?]$/i;
  if (danglingVerb.test(text)) {
    console.warn(`  ⚠ Dangling verb ending detected ("${text.slice(-30)}") — likely cut mid-sentence`);
    return null;
  }
  if (!endsClean) {
    // Check for common incomplete endings (contractions cut off)
    const truncatedEndings = [
      "they're", "we're", "it's", "that's", "there's",
      "you're", "he's", "she's", "who's", "what's",
      "don't", "doesn't", "didn't", "won't", "can't",
      "isn't", "aren't", "wasn't", "weren't",
      " the", " a", " an", " and", " but", " or",
      " to", " of", " in", " for", " on", " with",
    ];
    const lowerEnd = text.slice(-15).toLowerCase();
    const isTruncated = truncatedEndings.some(e => lowerEnd.endsWith(e));

    if (isTruncated || text.length < 40) {
      console.warn(`  ⚠ Truncated text detected (ends with ${lastChar}, ${text.length} chars)`);
      return null;
    }

    // Try to fix: find last complete sentence
    const lastPeriod = text.lastIndexOf('.');
    const lastExclaim = text.lastIndexOf('!');
    const lastQuestion = text.lastIndexOf('?');
    const lastSentenceEnd = Math.max(lastPeriod, lastExclaim, lastQuestion);

    if (lastSentenceEnd > text.length * 0.5) {
      // Cut at last sentence end if it's at least half the text
      text = text.substring(0, lastSentenceEnd + 1);
    } else {
      // Cut at last space and add period
      const lastSpace = text.lastIndexOf(' ');
      if (lastSpace > 50) text = text.substring(0, lastSpace) + '.';
      else return null; // Too short to fix
    }
  }

  return text;
}

// ─── Call Groq API ───────────────────────────────────────────────────────────

async function callGroq(messages, maxTokens = 300) {
  if (!groqKeys || groqKeys.totalKeys === 0) {
    throw new Error('No Groq keys configured');
  }

  const result = await groqKeys.execute(async (apiKey) => {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.9,
        max_tokens: maxTokens,  // Limit output to prevent long thinking
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'Unknown error');
      throw new Error(`Groq HTTP ${res.status}: ${errorText}`);
    }

    return await res.json();
  });

  return result?.choices?.[0]?.message?.content?.trim() || null;
}

// ─── Generate Tweet with Vision (image + text) ──────────────────────────────

export async function generateTweetWithVision(redditPost, isVideo = false) {
  const prompt = buildTweetPrompt(redditPost, isVideo);
  const imageUrl = redditPost.imageUrl;

  try {
    // Try with image first (vision mode)
    if (imageUrl) {
      const messages = [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }];

      const text = await callGroq(messages, 300);
      const cleaned = cleanTweetText(text);
      if (cleaned && cleaned.length >= MIN_TWEET_LENGTH) return { text: cleaned, model: 'groq-vision' };
    }

    // Fallback: text-only (no image)
    const textOnlyMessages = [{
      role: 'user',
      content: prompt
    }];

    const text = await callGroq(textOnlyMessages, 300);
    const cleaned = cleanTweetText(text);
    if (cleaned && cleaned.length >= MIN_TWEET_LENGTH) return { text: cleaned, model: 'groq-text' };

  } catch (err) {
    console.warn(`  ⚠ Groq failed: ${err.message}`);
  }

  return null;
}

/**
 * Turn an image-only Reddit post into a short factual brief before MiMo writes
 * the tweet. This avoids asking a text-only model to guess what the image shows.
 */
export async function generateImageBrief(redditPost) {
  if (!redditPost.imageUrl) return null;

  const prompt = `Analyze this image for a social post. Return ONLY a compact factual brief (max 450 characters).
Describe the product, UI, chart, code, tool, or result that is visibly shown. Do not invent names, claims, or numbers that are not visible.

Post title: ${redditPost.title || 'N/A'}
Post description: ${(redditPost.selftext || '').substring(0, 400) || 'No description supplied.'}`;

  try {
    const text = await callGroq([{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: redditPost.imageUrl } },
      ],
    }], 220);

    const brief = text?.replace(/\s+/g, ' ').trim();
    if (!brief || brief.length < 20) return null;
    return brief.substring(0, 450);
  } catch (err) {
    console.warn(`  ⚠ Groq image brief failed: ${err.message}`);
    return null;
  }
}

// ─── Generate Tweet with MiMo ────────────────────────────────────────────────

async function generateWithMiMo(redditPost, mimoKeys, isVideo = false) {
  if (!mimoKeys || mimoKeys.totalKeys === 0) return null;

  const MIMO_API_URL = process.env.MIMO_API_URL || 'https://api.xiaomimimo.com/v1/chat/completions';
  const MIMO_MODEL = process.env.MIMO_MODEL || 'mimo-v2.5-pro';

  // Retry loop: buildTweetPrompt picks a RANDOM hook on every call, so a second
  // attempt with a fresh prompt often yields a usable tweet when the first one
  // comes back empty, leaked meta-text, or too thin (< MIN_TWEET_LENGTH).
  // (Added Aug 7 — one run had MiMo fail on 2 posts and a flat raw title went live.)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildTweetPrompt(redditPost, isVideo);
    try {
      const result = await mimoKeys.execute(async (apiKey) => {
        const res = await fetch(MIMO_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: MIMO_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.78,
            max_completion_tokens: 800,
            // MiMo is a reasoning model — without disabling thinking it can spend
            // the whole token budget on reasoning_content and return empty content
            // (live Aug 10: "0 raw chars" on 2 attempts). Disabled = 4x faster,
            // ~5s/call, content always comes out. Verified with real pipeline prompt.
            thinking: { type: 'disabled' },
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (!res.ok) throw new Error(`MiMo HTTP ${res.status}`);
        return await res.json();
      });

      const text = result?.choices?.[0]?.message?.content?.trim();
      const cleaned = cleanTweetText(text);
      if (cleaned && cleaned.length >= MIN_TWEET_LENGTH) return { text: cleaned, model: 'mimo' };
      console.warn(`  ⚠ MiMo attempt ${attempt}: unusable output (${(text || '').length} raw chars) — retrying`);
    } catch (err) {
      console.warn(`  ⚠ MiMo attempt ${attempt} failed: ${err.message}`);
    }
  }

  return null;
}

// ─── Generate Tweet with Fallback Chain ─────────────────────────────────────
// Order: MiMo → Groq Vision → Groq Text → Raw title

export async function generateTweetWithFallback(redditPost, mimoKeys, isVideo = false) {
  // Image posts need visual facts before a text-only model writes — the image is
  // the primary content, so the vision brief is generated even when selftext exists.
  let enrichedPost = redditPost;
  if (redditPost.imageUrl) {
    console.log('  ▶ Analyzing image with Groq Vision for MiMo context...');
    const visualBrief = await generateImageBrief(redditPost);
    if (visualBrief) {
      enrichedPost = { ...redditPost, visualBrief };
      console.log(`  ✓ Vision brief: ${visualBrief.substring(0, 100)}...`);
    }
  }

  // 1. Try MiMo FIRST (more reliable, no thinking issue)
  const mimoResult = await generateWithMiMo(enrichedPost, mimoKeys, isVideo);
  if (mimoResult) return mimoResult;
  
  // 2. Fallback to Groq Vision (may have thinking issue but sees images)
  const groqResult = await generateTweetWithVision(redditPost, isVideo);
  if (groqResult) return groqResult;

  // 3. Use raw title as last resort (only if English — never post a non-English title)
  const rawFallback = smartTrimToTarget(redditPost.title || 'No content available');

  if (rawFallback.length < MIN_TWEET_LENGTH) {
    console.warn(`  ⚠ Raw title too thin (${rawFallback.length} chars < ${MIN_TWEET_LENGTH}) — skipping post`);
    return null;
  }

  if (!isLikelyEnglish(rawFallback)) {
    console.warn('  ⚠ Raw title is non-English — no usable tweet, skipping post');
    return null;
  }

  if (isAIPromptText(rawFallback)) {
    console.warn('  ⚠ Raw title is an AI image prompt — skipping post');
    return null;
  }

  if (!isQualityFallbackTitle(rawFallback)) {
    console.warn('  ⚠ Raw title is too short/generic — skipping post');
    return null;
  }

  return { text: rawFallback, model: 'raw-title' };
}

// ─── Generate Thread from Article ─────────────────────────────────────────────
// Used for HN/Dev.to fallback when full article content is available
// Generates 2-3 tweet thread summarizing the article

export async function generateThreadFromArticle(post, mimoKeys) {
  if (!post.selftext || post.selftext.length < 100) {
    // Not enough content for thread, use single tweet
    return null;
  }

  const today = new Date().toISOString().split('T')[0];
  const articleExcerpt = post.selftext.substring(0, 2500);
  
  const prompt = `You are @M_jawad_yasin, an AI Engineering expert on X (Twitter) with 50K+ followers.

CURRENT DATE: ${today}

TASK: Read this article and write a 2-3 tweet THREAD summarizing it.

ARTICLE TITLE: ${post.title}
SOURCE: ${post.subreddit || 'Unknown'}
UPVOTES: ${post.upvotes || 0}

ARTICLE CONTENT:
${articleExcerpt}

THREAD RULES:
- Write EXACTLY 2-3 tweets, separated by blank lines
- Each tweet: MAX 250 characters
- Tweet 1: HOOK — bold claim or surprising fact from the article
- Tweet 2: KEY INSIGHT — the most important finding or takeaway
- Tweet 3 (optional): YOUR OPINION — what this means, why it matters
- Be CONVERSATIONAL, like talking to a friend
- Make it DEBATABLE — people should want to reply
- NO hashtags, NO emojis, NO markdown
- NO "Thread:" or "1/" prefixes
- NO "Tweet 1:" labels — just the text separated by blank lines

THREAD:`;

  try {
    // Try MiMo first (more reliable for threads)
    if (mimoKeys && mimoKeys.totalKeys > 0) {
      const MIMO_API_URL = process.env.MIMO_API_URL || 'https://api.xiaomimimo.com/v1/chat/completions';
      const MIMO_MODEL = process.env.MIMO_MODEL || 'mimo-v2.5-pro';

      const result = await mimoKeys.execute(async (apiKey) => {
        const res = await fetch(MIMO_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: MIMO_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.8,
            max_completion_tokens: 800,
            thinking: { type: 'disabled' },
          }),
          signal: AbortSignal.timeout(45000),
        });

        if (!res.ok) throw new Error(`MiMo HTTP ${res.status}`);
        return await res.json();
      });

      let text = result?.choices?.[0]?.message?.content?.trim();
      if (!text) return null;

      // Clean up
      text = text.replace(/^["']|["']$/g, '');
      text = text.replace(/#[\w]+/g, '');
      text = stripMarkdown(text);
      text = stripMentions(text);
      text = fixStaleModelNames(text);
      text = text.trim();

      // Split into individual tweets (smart-trim each to the 240-char target)
      const tweets = text.split(/\n\n+/)
        .map(t => smartTrimToTarget(t.trim()))
        .filter(t => t.length > 10 && t.length <= 280)
        .slice(0, 3);

      if (tweets.length >= 2) {
        console.log(`  ✓ Generated ${tweets.length}-tweet thread`);
        return { tweets, model: 'mimo-thread' };
      }
    }
  } catch (err) {
    console.warn(`  ⚠ Thread generation failed: ${err.message}`);
  }

  return null;
}
