import { BridgeError } from './errors.mjs';

// An app-side safety budget. Azure's own quota can still be lower or shared
// with other clients, so its 429 responses remain authoritative.
export function createRateLimiter(now = () => Date.now()) {
  const buckets = new Map();
  return {
    take(deployment, tokensPerMinute, estimatedTokens) {
      if (!tokensPerMinute) return;
      if (estimatedTokens > tokensPerMinute)
        throw new BridgeError(`This request is estimated at ${estimatedTokens.toLocaleString()} tokens, above the configured ${tokensPerMinute.toLocaleString()} TPM budget for ${deployment}. Increase that model's TPM setting or send a smaller request.`, 429);
      const time = now();
      let bucket = buckets.get(deployment);
      if (!bucket) bucket = { available: tokensPerMinute, at: time, limit: tokensPerMinute };
      else {
        bucket.available = Math.min(tokensPerMinute, bucket.available + Math.max(0, time - bucket.at) * bucket.limit / 60000);
        bucket.at = time;
        bucket.limit = tokensPerMinute;
      }
      buckets.set(deployment, bucket);
      if (bucket.available < estimatedTokens) {
        const seconds = Math.ceil((estimatedTokens - bucket.available) * 60 / tokensPerMinute);
        throw new BridgeError(`Local TPM budget for ${deployment} is temporarily exhausted. Retry in about ${seconds} seconds.`, 429);
      }
      bucket.available -= estimatedTokens;
    }
  };
}
