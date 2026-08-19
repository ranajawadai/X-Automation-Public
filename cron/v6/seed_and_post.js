/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v6 — X (TWITTER) CONTENT PIPELINE                ║
 * ║   seed_and_post.js                                               ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Scrapes AI/tech X accounts for best content                    ║
 * ║   Rewrites in our hook/tone style                                ║
 * ║   Posts to X via Buffer with original images/GIFs/videos         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fetchXPosts } from '../lib/xscraper.js';
import { postSingleToBuffer, postVideoToBuffer } from '../lib/bufferClient.js';
import { isDuplicate, generateId, validateEnv, fixStaleModelNames, stripMarkdown, stripMentions, isLikelyEnglish, isAIPromptText, isQualityFallbackTitle } from '../lib/utils.js';
import { createKeyManager } from '../lib/keyManager.js';
import { sendSlack, buildSuccessMessage, buildFailureMessage, buildNoPostsMessage, buildPartialFailureMessage } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import { initGroqKeys, getGroqKeyStatus, generateImageBrief, generateTweetWithFallback } from '../lib/groqClient.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ─── Environment ──────────────────────────────────────────────────────────────
validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ─── Key Managers ─────────────────────────────────────────────────────────────
const mimoKeys = createKeyManager('MIMO', [
  process.env.MIMO_API_KEY,
  process.env.MIMO_API_KEY_2,
  process.env.MIMO_API_KEY_3,
  process.env.MIMO_API_KEY_4,
]);

const apifyKeys = createKeyManager('APIFY', [
  process.env.APIFY_API_KEY,
  process.env.APIFY_API_KEY_2,
  process.env.APIFY_API_KEY_3,
  process.env.APIFY_API_KEY_4,
  process.env.APIFY_API_KEY_5,
  process.env.APIFY_API_KEY_6,
  process.env.APIFY_API_KEY_7,
  process.env.APIFY_API_KEY_8,
  process.env.APIFY_API_KEY_9,
  process.env.APIFY_API_KEY_10,
  process.env.APIFY_API_KEY_11,
  process.env.APIFY_API_KEY_12,
  process.env.APIFY_API_KEY_13,
  process.env.APIFY_API_KEY_14,
  process.env.APIFY_API_KEY_15,
  process.env.APIFY_API_KEY_16,
  process.env.APIFY_API_KEY_17,
  process.env.APIFY_API_KEY_18,
  process.env.APIFY_API_KEY_19,
  process.env.APIFY_API_KEY_20,
  process.env.APIFY_API_KEY_21,
  process.env.APIFY_API_KEY_22,
  process.env.APIFY_API_KEY_23,
  process.env.APIFY_API_KEY_24,
  process.env.APIFY_API_KEY_25,
  process.env.APIFY_API_KEY_26,
]);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// Initialize Groq Vision keys (for image analysis before MiMo rewrite)
const groqKeys = initGroqKeys();

const DAILY_TARGET = 10;
const GLOBAL_DAILY_MAX = 50;
const POSTS_PER_RUN = 2;

// ─── Daily Counter ────────────────────────────────────────────────────────────

async function getTodayXPostCount() {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count, error } = await supabase
      .from('generated_posts')
      .select('*', { count: 'exact', head: true })
      // 'published' only — orphaned 'posting' rows (crash between save and status update) must not consume the daily quota
      .eq('status', 'published')
      .gte('db_created_at', todayStart.toISOString())
      .like('creator_handle', 'x/%');
    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.warn(`  ⚠ Could not get count: ${err.message}`);
    return -1;
  }
}

async function getTodayGlobalPostCount() {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from('generated_posts')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'published')
    .gte('db_created_at', todayStart.toISOString());
  if (error) throw error;

  const { count: queuedCount, error: queuedError } = await supabase
    .from('generated_posts')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'approved')
    .not('buffer_post_id', 'is', null)
    .gte('db_created_at', todayStart.toISOString());
  if (queuedError) throw queuedError;
  return (count || 0) + (queuedCount || 0);
}

// ─── Rewrite with MiMo (with Groq Vision image analysis) ─────────────────────

// Fallback title helper — never return a non-English, AI-prompt, or low-quality raw title
function fallbackTitle(title) {
  const truncated = (title || '').substring(0, 275);
  return isLikelyEnglish(truncated) && !isAIPromptText(truncated) && isQualityFallbackTitle(truncated) ? truncated : null;
}

// Fall back to the shared Groq chain (Groq Vision -> Groq text -> raw title) when the MiMo rewrite fails
async function fallbackWithGroq(originalPost) {
  const result = await generateTweetWithFallback(originalPost, mimoKeys, false);
  if (result?.text) return result.text;
  return fallbackTitle(originalPost.title);
}

async function rewriteWithMiMo(originalPost, visualBrief = null) {
  if (mimoKeys.totalKeys === 0) {
    return fallbackTitle(originalPost.title);
  }

  // Detect if this is a company account
  const companyAccounts = ['OpenAI', 'AnthropicAI', 'GoogleDeepMind', 'MetaAI', 'nvidia', 'StabilityAI', 'CohereForAI'];
  const isCompany = companyAccounts.includes(originalPost.author);
  
  // Company-specific context
  let companyContext = '';
  if (isCompany) {
    companyContext = `\nThis is from @${originalPost.author} (official company account). Mention them naturally: "@${originalPost.author} just released..." or "@${originalPost.author} announced..."`;
  }

  // Media context with Groq Vision breakdown
  let mediaContext = '';
  if (visualBrief) {
    mediaContext = `\nIMAGE ANALYSIS (from vision AI — use these details to write about what you SEE):\n${visualBrief}`;
  } else if (originalPost.imageUrl) {
    mediaContext = '\nThis post has an IMAGE attached. Reference the visual content in your rewrite.';
  } else if (originalPost.videoUrl) {
    mediaContext = '\nThis post has a VIDEO attached. Reference the video/demo in your rewrite.';
  } else if (originalPost.gifUrl) {
    mediaContext = '\nThis post has a GIF attached. Reference the animated content in your rewrite.';
  }

  const today = new Date().toISOString().split('T')[0];
  const prompt = `You are @M_jawad_yasin, an AI Engineering expert on X (Twitter) with 50K+ followers.

CURRENT DATE: ${today}

TASK: Rewrite this tweet in YOUR style. Make it engaging and clear what the post is about.

ORIGINAL TWEET:
"${originalPost.title}"
From: @${originalPost.author}
Engagement: ${originalPost.likes} likes, ${originalPost.retweets} retweets${companyContext}${mediaContext}

REWRITE RULES:
- MAX 240 characters (hard limit — MUST fit within X's 280-character free plan)
- IMPORTANT: If the original tweet is NOT in English, first TRANSLATE the full meaning into English, then rewrite in your style. Output must be 100% English.
- Use a STRONG HOOK to open: bold claim, shocking stat, provocative question, or bold prediction (60-100 chars)
- Then a BODY: one clear sentence on WHAT the post is about and WHY it matters (60-100 chars)
- Then a CTA: short closing nudge to engage — "Try it", "This changes everything", "Thoughts?" (10-40 chars)
- Keep the CORE MESSAGE but make it more engaging
- If it's a company announcement, mention them naturally (e.g., "@OpenAI just dropped...")
- If it's an influencer, add your perspective
- If there's an image/video, reference what it shows using the IMAGE ANALYSIS
- NO hashtags, NO emojis, NO markdown
- NO "Thread:" or "1/" prefixes
- Just the rewritten tweet, nothing else

REWRITTEN TWEET:`;

  try {
    const result = await mimoKeys.execute(async (apiKey) => {
      const res = await fetch(process.env.MIMO_API_URL || 'https://api.xiaomimimo.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: process.env.MIMO_MODEL || 'mimo-v2.5-pro',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.85,
          max_completion_tokens: 800,
          // MiMo is a reasoning model — disable thinking so it cannot burn the token budget
          // on reasoning_content and return empty content (live Aug 10: 0 raw chars).
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });

    let text = result?.choices?.[0]?.message?.content?.trim();
    if (!text) return await fallbackWithGroq(originalPost);

    // Clean up
    text = text.replace(/^["']|["']$/g, '');
    text = text.replace(/#[\w]+/g, '');
    text = stripMarkdown(text);
    text = stripMentions(text);
    text = fixStaleModelNames(text);
    text = text.trim();

// Language filter: reject non-English text (Chinese, Spanish, Turkish, Arabic, etc.)
    if (!isLikelyEnglish(text)) {
      console.warn(`  ⚠ Non-English text detected — SKIPPING post`);
      return null;  // Skip entirely — raw title is also non-English
    }

    // Validate length
    if (text.length < 15 || text.length > 280) {
      return fallbackTitle(originalPost.title);
    }

    return text;
  } catch (err) {
    console.warn(`  ⚠ MiMo failed: ${err.message}`);
    return await fallbackWithGroq(originalPost);
  }
}

// ─── Save + Post ──────────────────────────────────────────────────────────────

async function saveXPost(post, text, status = 'posting') {
  try {
    const { error } = await supabase.from('generated_posts').insert({
      id: generateId('v6'),
      original_post_id: post.tweetUrl,
      creator_handle: `x/${post.author}`,
      creator_name: `x/${post.author}`,
      generated_text: text,
      status,
      source_url: post.tweetUrl,
      buffer_post_id: null
    });
    if (error) throw error;
    console.log('  ✓ Saved to Supabase');
  } catch (err) {
    console.warn(`  ⚠ Save failed: ${err.message}`);
    throw err;
  }
}

async function updateXPostStatus(tweetUrl, status, bufferPostId = null) {
  try {
    const { error } = await supabase.from('generated_posts')
      .update({ status, buffer_post_id: bufferPostId })
      .eq('source_url', tweetUrl)
      .eq('status', 'posting');
    if (error) throw error;
  } catch (err) {
    console.warn(`  ⚠ Status update failed: ${err.message}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🐦  X-AUTOMATION v6 — X (TWITTER) CONTENT PIPELINE         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Buffer  : ${process.env.BUFFER_API_KEY ? '✓' : '✗ (dry run)'}`);
  console.log(`  MiMo    : ${mimoKeys.totalKeys} key(s) loaded`);
  console.log(`  Apify   : ${apifyKeys.totalKeys} key(s) loaded`);
  console.log(`  Target  : ${POSTS_PER_RUN} posts this run`);
  console.log('');
  const pipeline = 'v6';
  const run = startRun(pipeline);

  try {
    // Check daily count
    const todayCount = await getTodayXPostCount();
    const globalTodayCount = await getTodayGlobalPostCount();
    console.log(`  📊 Today's X posts: ${todayCount}/${DAILY_TARGET}`);
    if (todayCount >= DAILY_TARGET || globalTodayCount >= GLOBAL_DAILY_MAX) {
      console.log(`  ✅ Daily target reached! Skipping.`);
      await run.noPosts(0);
      return;
    }
    const remaining = DAILY_TARGET - todayCount;
    const globalRemaining = GLOBAL_DAILY_MAX - globalTodayCount;
    const postsToMake = Math.min(POSTS_PER_RUN, remaining, globalRemaining);
    console.log(`  📈 Need ${remaining} X posts and ${globalRemaining} total slots; will post ${postsToMake}`);

    // Check Apify balances
    console.log('\n  💰 Checking Apify balances...');
    await apifyKeys.checkBalances();

    // Fetch X posts
    console.log('\n▶ STEP 1: Scraping X accounts...');
    const xPosts = await fetchXPosts(apifyKeys, undefined, postsToMake + 2);

    if (xPosts.length === 0) {
      console.log('  ⚠ No X posts found. Exiting.');
      run.setApifyKeyStatus(apifyKeys.getStatus());
      await run.noPosts(5);
      await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: 5, keyStatus: apifyKeys.getStatus(), mimoKeyStatus: mimoKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
      return;
    }

    // Select posts (dedup check). Non-English posts are KEPT — MiMo will
    // translate them to English during rewrite (avoids wasting scrape cost).
    console.log('\n▶ STEP 2: Selecting posts (dedup check)...');
    const selectedPosts = [];
    for (const post of xPosts) {
      if (selectedPosts.length >= postsToMake) break;
      if (!await isDuplicate(supabase, post.tweetUrl)) {
        selectedPosts.push(post);
        console.log(`  ✓ Selected: @${post.author} — ${post.title.substring(0, 50)}...`);
      }
    }

    if (selectedPosts.length === 0) {
      console.log('  ⚠ All posts already posted. Exiting.');
      run.setApifyKeyStatus(apifyKeys.getStatus());
      await run.noPosts(5);
      return;
    }

    console.log(`\n  📝 Will post ${selectedPosts.length} posts this run`);
    run.setApifyKeyStatus(apifyKeys.getStatus());
    run.setMimoKeyStatus(mimoKeys.getStatus());
    run.setGroqKeyStatus(getGroqKeyStatus());

    // Process each post
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < selectedPosts.length; i++) {
      const post = selectedPosts[i];
      const postNum = `[${i + 1}/${selectedPosts.length}]`;

      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  POST ${postNum}: @${post.author} — ${post.title.substring(0, 60)}...`);
      console.log(`  ❤️ ${post.likes} | 🔄 ${post.retweets} | 💬 ${post.replies}`);
      console.log(`${'═'.repeat(60)}`);

      try {
        // Analyze image with Groq Vision before MiMo rewrite
        let visualBrief = null;
        if (post.imageUrl) {
          console.log(`\n  ▶ Analyzing image with Groq Vision...`);
          visualBrief = await generateImageBrief(post);
          if (visualBrief) {
            console.log(`  ✓ Vision brief: ${visualBrief.substring(0, 100)}...`);
          } else {
            console.log(`  ⚠ Vision brief failed — MiMo will rewrite without image context`);
          }
        }

        // Rewrite with MiMo (using Groq Vision breakdown if available)
        console.log(`\n  ▶ Rewriting with MiMo...`);
        const postText = await rewriteWithMiMo(post, visualBrief);

        if (!postText || postText.trim().length === 0) {
          console.log(`  ⚠ Rewrite failed or non-English — skipping post`);
          failCount++;
          continue;
        }
        console.log(`  ✓ Rewritten: ${postText.substring(0, 80)}...`);

        // Save to Supabase
        console.log(`  ▶ Saving to Supabase...`);
        await saveXPost(post, postText, 'posting');

        // Preserve direct video assets; use the image path for images and GIFs.
        console.log(`  ▶ Posting to X via Buffer...`);
        const bufferResult = post.videoUrl
          ? await postVideoToBuffer(postText, post.videoUrl, post.imageUrl || null)
          : await postSingleToBuffer(postText, post.imageUrl || post.gifUrl || null);

        await updateXPostStatus(post.tweetUrl, bufferResult.success ? 'published' : 'failed', bufferResult.postId || null);

        if (bufferResult.success) {
          successCount++;
          console.log(`  ✅ PUBLISHED! (${bufferResult.postId})`);

          // Slack notification
          const slackResult = await sendSlack(buildSuccessMessage({
            pipeline,
            text: postText,
            subreddit: post.author,
            upvotes: post.likes,
            imageUrl: post.imageUrl,
            redditUrl: post.tweetUrl,
            bufferId: bufferResult.postId,
            elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
            keyStatus: apifyKeys.getStatus(),
            redditTitle: post.title,
            comments: post.replies,
            charCount: postText.length,
            mimoKeyStatus: mimoKeys.getStatus(),
            groqKeyStatus: getGroqKeyStatus(),
            modelUsed: visualBrief ? 'groq-vision+mimo' : 'mimo',
            todayCount: await getTodayXPostCount(),
          }));
          run.setSlackSent(slackResult.ok);
        } else {
          failCount++;
          console.log(`  ❌ Failed: ${bufferResult.reason}`);
        }

        // Delay between posts
        if (i < selectedPosts.length - 1) {
          const delay = Math.floor(Math.random() * 60) + 30;
          console.log(`  ⏳ Waiting ${delay}s...`);
          await new Promise(r => setTimeout(r, delay * 1000));
        }
      } catch (err) {
        failCount++;
        console.error(`  ❌ Failed: ${err.message}`);
      }
    }

    // Alert on partial per-post failures (N2)
    if (failCount > 0) {
      const partialResult = await sendSlack(buildPartialFailureMessage({
        pipeline,
        successCount,
        failCount,
        keyStatus: apifyKeys.getStatus(),
        mimoKeyStatus: mimoKeys.getStatus(),
        groqKeyStatus: getGroqKeyStatus(),
      }));
      if (partialResult.ok) console.log('  ✓ Partial-failure alert sent to Slack');
    }

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalCount = await getTodayXPostCount();
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  📊  v6 PIPELINE COMPLETE                                    ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Posts  : ${String(`${successCount} success, ${failCount} failed`).padEnd(49)}║`);
    console.log(`║  Daily  : ${String(`${finalCount}/${DAILY_TARGET}`).padEnd(49)}║`);
    console.log(`║  Time   : ${String(`${elapsed}s`).padEnd(49)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    await run.success();

  } catch (err) {
    console.error('\n❌ v6 PIPELINE FATAL:', err.message);
    const slackResult = await sendSlack(buildFailureMessage({ pipeline, step: 'pipeline', error: err.message, keyStatus: apifyKeys.getStatus(), mimoKeyStatus: mimoKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
    run.setSlackSent(slackResult.ok);
    await run.fail(err);
    process.exitCode = 1;
  }
}

process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled:', reason); process.exitCode = 1; });
main().catch((err) => { console.error('❌ main() failed:', err); process.exitCode = 1; });
