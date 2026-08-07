/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION — AUTO QUOTE-TWEET PIPELINE                  ║
 * ║   auto_reply.js                                              ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║   Scrapes X accounts → picks best post → Groq generates     ║
 * ║   a contextual comment → Buffer posts as Quote Tweet        ║
 * ║                                                              ║
 * ║   Schedule: 5x/day (testing phase)                          ║
 * ║   Target: 1 quote tweet per run                             ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fetchXPosts } from './lib/xscraper.js';
import { postQuoteTweet } from './lib/bufferClient.js';
import { isDuplicate, generateId, validateEnv, stripMarkdown, stripMentions, fixStaleModelNames, isLikelyEnglish } from './lib/utils.js';
import { createKeyManager } from './lib/keyManager.js';
import { sendSlack, buildSuccessMessage, buildFailureMessage, buildNoPostsMessage } from './lib/slackClient.js';
import { startRun } from './lib/logger.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ─── Environment ──────────────────────────────────────────────────────────────
validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
]);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const DAILY_TARGET = 5; // Testing phase: 5 quote tweets per day
const QUOTE_TWEETS_PER_RUN = 1;
const MIN_ENGAGEMENT = 50; // Minimum likes + RT×2 + replies (reduced from 100 for more variety)

// ─── Generate Quote Tweet Comment with Groq/MiMo ─────────────────────────────

async function generateComment(originalPost) {
  const today = new Date().toISOString().split('T')[0];
  const prompt = `You are @M_jawad_yasin, an AI Engineering expert on X (Twitter) with 50K+ followers.

CURRENT DATE: ${today}

TASK: Write a SHORT insightful comment to QUOTE TWEET this post. This will appear as a quote tweet with the original embedded.

ORIGINAL TWEET:
"${originalPost.title}"
From: @${originalPost.author}
Engagement: ${originalPost.likes} likes, ${originalPost.retweets} retweets

COMMENT RULES:
- MAX 240 characters (hard limit — MUST fit within X's 280-character free plan)
- IMPORTANT: If the original tweet is NOT in English, first TRANSLATE its meaning into English, then write your comment. Output must be 100% English.
- Structure: HOOK (a sharp, opinionated opening take, 60-100 chars) → BODY (add your unique value/analysis/prediction) → CTA or punchy close (nudge to agree/reply, 10-40 chars)
- Add your UNIQUE PERSPECTIVE — don't just repeat what they said
- Be CONVERSATIONAL, like talking to a smart friend
- Make it DEBATABLE — people should want to reply to YOUR take
- Reference the original content naturally
- If it's a tool, share your experience or opinion
- If it's news, add analysis or a prediction
- If it's a debate, take a clear side
- NO hashtags, NO emojis, NO markdown
- NO "Thread:" or "1/" prefixes
- NO "Great post!" or generic praise — add value
- Just the comment text, nothing else

YOUR COMMENT:`;

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
          max_completion_tokens: 300,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

    // Validate
    if (text.length < 10 || text.length > 280) return null;

    // Language guard — never quote-tweet a non-English comment
    if (!isLikelyEnglish(text)) {
      console.warn('  ⚠ Non-English comment detected — skipping');
      return null;
    }

    return text;
  } catch (err) {
    console.warn(`  ⚠ Comment generation failed: ${err.message}`);
    return null;
  }
}

// ─── Daily Counter ────────────────────────────────────────────────────────────

async function getTodayQuoteCount() {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count, error } = await supabase
      .from('generated_posts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'published')
      .gte('db_created_at', todayStart.toISOString())
      .like('creator_handle', 'quote/%');
    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.warn(`  ⚠ Could not get count: ${err.message}`);
    return -1;
  }
}

// ─── Save Quote Tweet to Supabase ─────────────────────────────────────────────

async function saveQuoteTweet(post, comment, status = 'posting') {
  try {
    const { error } = await supabase.from('generated_posts').insert({
      id: generateId('qt'),
      original_post_id: post.tweetUrl,
      creator_handle: `quote/${post.author}`,
      creator_name: `quote/${post.author}`,
      generated_text: comment,
      status,
      source_url: post.tweetUrl,
      buffer_post_id: null,
    });
    if (error) throw error;
    console.log('  ✓ Saved to Supabase');
  } catch (err) {
    console.warn(`  ⚠ Save failed: ${err.message}`);
    throw err;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  💬  X-AUTOMATION — AUTO QUOTE-TWEET PIPELINE               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Buffer  : ${process.env.BUFFER_API_KEY ? '✓' : '✗ (dry run)'}`);
  console.log(`  MiMo    : ${mimoKeys.totalKeys} key(s) loaded`);
  console.log(`  Apify   : ${apifyKeys.totalKeys} key(s) loaded`);
  console.log(`  Target  : ${QUOTE_TWEETS_PER_RUN} quote tweet(s) this run`);
  console.log('');
  const pipeline = 'quote_tweet';
  const run = startRun(pipeline);

  try {
    // Check daily count
    const todayCount = await getTodayQuoteCount();
    console.log(`  📊 Today's quote tweets: ${todayCount}/${DAILY_TARGET}`);
    if (todayCount >= DAILY_TARGET) {
      console.log(`  ✅ Daily target reached! Skipping.`);
      await run.noPosts(0);
      return;
    }

    // Pre-flight key check
    console.log('\n  💰 Checking Apify balances...');
    await apifyKeys.checkBalances();

    // Step 1: Scrape X accounts
    console.log('\n▶ STEP 1: Scraping X accounts for quote tweet targets...');
    const xPosts = await fetchXPosts(apifyKeys, undefined, 10, 3); // 3 accounts × 2 items = 6 posts (faster, avoids timeout)

    if (xPosts.length === 0) {
      console.log('  ⚠ No X posts found. Exiting.');
      run.setApifyKeyStatus(apifyKeys.getStatus());
      await run.noPosts(5);
      await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: 5, keyStatus: apifyKeys.getStatus(), mimoKeyStatus: mimoKeys.getStatus() }));
      return;
    }

    // Step 2: Filter for high engagement posts
    console.log('\n▶ STEP 2: Filtering for high engagement...');
    const highEngagement = xPosts.filter(p => p.engagement >= MIN_ENGAGEMENT);
    console.log(`  ✓ ${highEngagement.length} posts with engagement >= ${MIN_ENGAGEMENT}`);

    if (highEngagement.length === 0) {
      console.log('  ⚠ No high engagement posts. Exiting.');
      run.setApifyKeyStatus(apifyKeys.getStatus());
      await run.noPosts(5);
      return;
    }

    // Step 3: Dedup check — pick best non-duplicate
    console.log('\n▶ STEP 3: Selecting quote tweet target (dedup check)...');
    let targetPost = null;
    for (const post of highEngagement) {
      if (!await isDuplicate(supabase, post.tweetUrl)) {
        targetPost = post;
        break;
      }
    }

    if (!targetPost) {
      console.log('  ⚠ All high engagement posts already quote-tweeted. Exiting.');
      run.setApifyKeyStatus(apifyKeys.getStatus());
      await run.noPosts(5);
      return;
    }

    console.log(`  ✓ Selected: @${targetPost.author} — ${targetPost.title.substring(0, 50)}...`);
    console.log(`    ❤️ ${targetPost.likes} | 🔄 ${targetPost.retweets} | 💬 ${targetPost.replies}`);
    run.setApifyKeyStatus(apifyKeys.getStatus());
    run.setMimoKeyStatus(mimoKeys.getStatus());

    // Step 4: Generate comment
    console.log('\n▶ STEP 4: Generating quote tweet comment...');
    const comment = await generateComment(targetPost);

    if (!comment || comment.length < 10) {
      console.log('  ⚠ Comment generation failed. Exiting.');
      return;
    }

    console.log(`  ✓ Comment (${comment.length} chars): "${comment.substring(0, 80)}..."`);

    // Step 5: Save + Post
    console.log('\n▶ STEP 5: Posting quote tweet...');
    // Extract tweet ID from URL for quote tweet
    const tweetIdMatch = targetPost.tweetUrl?.match(/\/status\/(\d+)/);
    const tweetId = tweetIdMatch ? tweetIdMatch[1] : null;

    if (!tweetId) {
      console.log('  ⚠ Could not extract tweet ID. Skipping without creating a DB record.');
      return;
    }

    await saveQuoteTweet(targetPost, comment, 'posting');

    const bufferResult = await postQuoteTweet(comment, tweetId);

    if (bufferResult.success) {
      console.log(`  ✅ QUOTE TWEETED! (Buffer ID: ${bufferResult.postId})`);

      // Update Supabase status
      await supabase.from('generated_posts')
        .update({ status: 'published', buffer_post_id: bufferResult.postId })
        .eq('source_url', targetPost.tweetUrl)
        .eq('status', 'posting');

      // Slack notification
      const slackResult = await sendSlack(buildSuccessMessage({
        pipeline,
        text: comment,
        subreddit: targetPost.author,
        upvotes: targetPost.likes,
        imageUrl: targetPost.imageUrl,
        redditUrl: targetPost.tweetUrl,
        bufferId: bufferResult.postId,
        elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
        keyStatus: apifyKeys.getStatus(),
        redditTitle: targetPost.title,
        comments: targetPost.replies,
        charCount: comment.length,
        mimoKeyStatus: mimoKeys.getStatus(),
        modelUsed: 'mimo',
        todayCount: await getTodayQuoteCount(),
      }));
      run.setSlackSent(slackResult.ok);
    } else {
      console.log(`  ❌ Buffer failed: ${bufferResult.reason}`);
      await supabase.from('generated_posts')
        .update({ status: 'failed' })
        .eq('source_url', targetPost.tweetUrl)
        .eq('status', 'posting');
    }

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  📊  QUOTE-TWEET PIPELINE COMPLETE                          ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Status : ${String(bufferResult.success ? '✅ Success' : '❌ Failed').padEnd(49)}║`);
    console.log(`║  Target : ${String(`@${targetPost.author}`).padEnd(49)}║`);
    console.log(`║  Time   : ${String(`${elapsed}s`).padEnd(49)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    run.setPost({
      title: targetPost.title,
      url: targetPost.tweetUrl,
      upvotes: targetPost.likes,
      subreddit: targetPost.author,
      generatedText: comment,
      imageUrl: targetPost.imageUrl,
    });

    await run.success();

  } catch (err) {
    console.error('\n❌ QUOTE-TWEET FATAL:', err.message);
    const slackResult = await sendSlack(buildFailureMessage({ pipeline, step: 'pipeline', error: err.message, keyStatus: apifyKeys.getStatus(), mimoKeyStatus: mimoKeys.getStatus() }));
    run.setSlackSent(slackResult.ok);
    await run.fail(err);
    process.exitCode = 1;
  }
}

process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled:', reason); process.exitCode = 1; });
main().catch((err) => { console.error('❌ main() failed:', err); process.exitCode = 1; });
