/**
 * X (Twitter) Content Scraper for X-Automation pipelines.
 * Scrapes AI/tech X accounts using maximedupre/twitter-media-scraper.
 * Cost: $1.60/1000 media links (free plan credits)
 * Cost optimized: 5 accounts × 2 posts = 10 scrapings per run (50/day total)
 *
 * Returns posts with images/GIFs/videos for reposting in our style.
 */

import { createKeyManager } from './keyManager.js';

const APIFY_ACTOR = 'maximedupre~twitter-media-scraper';

// Target AI/tech accounts to scrape
const AI_ACCOUNTS = [
  // Company accounts (official announcements)
  'OpenAI',
  'AnthropicAI',
  'GoogleDeepMind',
  'MetaAI',
  'nvidia',
  'StabilityAI',
  'CohereForAI',
  // Influencer accounts
  'DAIEvolutionHub',
  'LuminaXspace',
  'vampScally',
  'Hartdrawss',
  'Nozelcode',
  'ihteshamali',
  'AIVersePlay',
  'oliviscusAI',
  'VersunPan',
  'QCXINT_',
  'Urooj978',
  '0xJokker',
  'SCR01111',
  'abue_ammar',
  '0xKento_',
  'sweexx9',
  'DivyanshT91162',
  'Crypto_hedyEth',
  '0xCheshire',
  'yigitakinkaya',
  // New accounts (user-provided)
  'forloopcodes',
  'NovaXCode',
  'HarshithLucky3',
  'RoundtableSpace',
  '0x0SojalSec'
];

/**
 * Fetch recent posts from X accounts using Apify
 * @param {KeyManager} apifyKeys - Apify key manager
 * @param {string[]} accounts - Account usernames to scrape
 * @param {number} maxPosts - Max posts to return
 * @param {number} maxAccounts - Max accounts to scrape per run (default 5 for v6, 3 for quote tweet)
 * @returns {Promise<Array>} Posts with media
 */
export async function fetchXPosts(apifyKeys, accounts = AI_ACCOUNTS, maxPosts = 10, maxAccounts = 5) {
  console.log('\n▶ X (TWITTER) SCRAPER via Apify (maximedupre)');
  console.log(`  Scraping ${maxAccounts} of ${accounts.length} accounts...`);

  const allPosts = [];

  // Scrape random accounts per run
  const selectedAccounts = shuffleArray(accounts).slice(0, maxAccounts);

  for (const account of selectedAccounts) {
    try {
      console.log(`  → Scraping @${account}...`);
      const posts = await scrapeAccount(apifyKeys, account);
      console.log(`    Found ${posts.length} posts from @${account}`);
      allPosts.push(...posts);
    } catch (err) {
      console.warn(`  ⚠ Failed to scrape @${account}: ${err.message}`);
    }
  }

  // Filter for posts with text + media
  const mediaPosts = allPosts.filter(hasMedia);
  console.log(`  ✓ ${mediaPosts.length} qualifying posts from ${allPosts.length} total`);

  // Sort by engagement and return top posts
  const sorted = mediaPosts.sort((a, b) => b.engagement - a.engagement);
  const result = sorted.slice(0, maxPosts);

  console.log(`  ✓ ${result.length} qualifying X posts`);
  result.forEach((p, i) => {
    console.log(`  ${i + 1}. @${p.author}: ${p.title.substring(0, 50)}... [${p.likes}❤️]`);
  });

  return result;
}

/**
 * Scrape a single X account using Apify
 */
async function scrapeAccount(apifyKeys, username) {
  if (apifyKeys.totalKeys === 0) return [];

  try {
    const items = await apifyKeys.execute(async (apiKey) => {
      const runRes = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'profiles',
          profiles: [username],
          mediaTypes: ['image', 'video', 'gif'],
          maxItems: 2  // Cost optimized: 2 media items per account
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (!runRes.ok) throw new Error(`HTTP ${runRes.status}`);
      const runData = await runRes.json();
      const runId = runData.data?.id;
      if (!runId) throw new Error('No run ID');

      // Wait for completion (max 150 seconds — new actor needs more time)
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const sRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apiKey}`, {
          signal: AbortSignal.timeout(10000)
        });
        const sData = await sRes.json();

        if (sData.data?.status === 'SUCCEEDED') {
          const dId = sData.data?.defaultDatasetId;
          if (dId) {
            const iRes = await fetch(`https://api.apify.com/v2/datasets/${dId}/items?token=${apiKey}&format=json&limit=5`, {
              signal: AbortSignal.timeout(15000)
            });
            return await iRes.json();
          }
        }
        if (sData.data?.status === 'FAILED') throw new Error('Run failed');
      }
      throw new Error('Timeout');
    });

    return parseXPosts(items || [], username);
  } catch (err) {
    console.warn(`  ⚠ Apify failed for @${username}: ${err.message}`);
    return [];
  }
}

/**
 * Parse X posts from maximedupre/twitter-media-scraper response.
 * Each item = one media item. Group by tweetId to get unique tweets.
 */
function parseXPosts(items, username) {
  // Group by tweetId (one tweet can have multiple media items)
  const tweetMap = new Map();

  for (const item of items) {
    const tweetId = item.tweetId || item.tweetUrl || `unknown_${Math.random()}`;
    const author = (item.authorUsername || username).replace('@', '');

    // Safety filter: only accept posts from target account
    if (author.toLowerCase() !== username.toLowerCase().replace('@', '')) {
      console.log(`    ⚠ Skipping post from @${author} (expected @${username})`);
      continue;
    }

    // Skip if we already have this tweet
    if (tweetMap.has(tweetId)) continue;

    // Extract media URL based on type
    let imageUrl = null;
    let videoUrl = null;
    let gifUrl = null;

    if (item.mediaType === 'image') {
      imageUrl = item.mediaUrl;
    } else if (item.mediaType === 'video') {
      videoUrl = item.mediaUrl;
      // Use thumbnail as image fallback
      if (item.thumbnailUrl) imageUrl = item.thumbnailUrl;
    } else if (item.mediaType === 'gif') {
      gifUrl = item.mediaUrl;
      imageUrl = item.mediaUrl; // GIF can also be used as image
    }

    const likes = item.engagement?.likes || 0;
    const retweets = item.engagement?.retweets || 0;
    const replies = item.engagement?.replies || 0;

    tweetMap.set(tweetId, {
      title: item.text || '',
      author: author,
      likes: likes,
      retweets: retweets,
      replies: replies,
      engagement: likes + retweets * 2 + replies,
      imageUrl: imageUrl,
      videoUrl: videoUrl,
      gifUrl: gifUrl,
      tweetUrl: item.tweetUrl || `https://x.com/${author}/status/${tweetId}`,
      source: 'x_scraping',
    });
  }

  return Array.from(tweetMap.values());
}

/**
 * Check if post has media (images/GIFs/videos) and quality text
 */
function hasMedia(post) {
  const hasMediaContent = post.imageUrl || post.videoUrl || post.gifUrl;
  if (!hasMediaContent) return false;
  if (!post.title || post.title.length < 10) return false;

  const spamWords = ['follow me', 'subscribe', 'check my', 'dm me', 'link in bio'];
  const titleLower = post.title.toLowerCase();
  if (spamWords.some(word => titleLower.includes(word))) return false;

  return true;
}

/**
 * Shuffle array (Fisher-Yates)
 */
function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
