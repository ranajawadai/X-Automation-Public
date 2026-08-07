import assert from 'node:assert/strict';
import { cleanTweetText } from './groqClient.js';

assert.equal(cleanTweetText('No hashtags, emojis, or markdown.'), null);
assert.equal(cleanTweetText('Remember, no emojis and no hashtags.'), null);
assert.equal(
  cleanTweetText('Open-source tools are quietly becoming the fastest path from idea to production.'),
  'Open-source tools are quietly becoming the fastest path from idea to production.'
);

console.log('groqClient cleanTweetText regression checks passed');
