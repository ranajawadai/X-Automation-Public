export const X_MAX_CHARS = 280;
export const X_SAFE_MAX_CHARS = 277;

export function smartTrimTweet(text: string): string {
  if (!text) return '';
  if (text.length <= X_SAFE_MAX_CHARS) return text;
  const cuts = [
    text.lastIndexOf('.', X_SAFE_MAX_CHARS),
    text.lastIndexOf('\n', X_SAFE_MAX_CHARS),
    text.lastIndexOf('—', X_SAFE_MAX_CHARS),
    text.lastIndexOf(' ', X_SAFE_MAX_CHARS)
  ];
  const best = Math.max(...cuts.filter((c) => c >= 80));
  if (best >= 80) return text.substring(0, best + 1).trim();
  return text.substring(0, X_SAFE_MAX_CHARS - 1).trim() + '…';
}

export function enforceThreadCharLimits(tweets: string[]): string[] {
  return tweets.map((t) => {
    const trimmed = smartTrimTweet(t.trim());
    if (trimmed.length > X_MAX_CHARS) {
      return trimmed.substring(0, X_MAX_CHARS - 1) + '…';
    }
    return trimmed;
  });
}

export function threadWithinLimits(tweets: string[]): boolean {
  return tweets.every((t) => t.length > 0 && t.length <= X_MAX_CHARS);
}
