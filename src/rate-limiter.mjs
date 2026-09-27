import { BridgeError } from './errors.mjs';

// Per-deployment tokens-per-minute queue. Requests reserve estimated tokens
// from a budget that refills continuously (limit/60000 tokens per ms).
// A request that fits goes immediately, even past older waiters that don't
// fit yet; once the oldest waiter has waited `agingMs`, nothing may pass it
// until it fits, so large requests cannot starve. A request larger than the
// whole budget is admitted alone when the budget is full. Deployments without
// a budget (tokensPerMinute 0) are never queued. Azure's own 429s remain
// authoritative: pause() holds a deployment's queue for the Retry-After time.
export function createTpmQueue({ now = () => Date.now(), agingMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const states = new Map();
  let nextId = 1;

  const fresh = limit => ({ limit, available: limit, at: now(), pausedUntil: 0, waiters: [], timer: null, stats: { admitted: 0, queued: 0, jumped: 0, totalWaitMs: 0, maxWaitMs: 0, throttled: 0, cancelled: 0 } });

  function refill(s, t) {
    if (s.limit > 0 && t > s.at) s.available = Math.min(s.limit, s.available + (t - s.at) * s.limit / 60000);
    s.at = t;
  }
  const fits = (s, tokens) => tokens <= s.available + 1e-6 || (tokens > s.limit && s.available >= s.limit - 1e-6);

  function makeTicket(s, deployment, w, t, jumped) {
    const waitedMs = Math.max(0, t - w.enqueuedAt);
    let settled = false;
    return {
      deployment, tokens: w.tokens, waitedMs, queued: waitedMs > 0, jumpedAhead: jumped,
      // Once the request finishes, charge what it really used (input plus
      // output) and return the rest of the reservation. Holding the full max
      // output reservation measured stricter than Azure's own limiter (long
      // queue waits with zero Azure 429s); Azure 429s still pause the queue.
      settle(actual) {
        const used = typeof actual === 'number' ? actual + (w.tokens - w.estimatedInputTokens) : (actual?.inputTokens || 0) + (actual?.outputTokens || 0);
        if (settled || !s || !(s.limit > 0) || !(used > 0)) return;
        settled = true;
        refill(s, now());
        s.available = Math.min(s.limit, s.available + (w.tokens - used));
        pump(s);
      },
    };
  }

  function admit(s, index, t) {
    const [w] = s.waiters.splice(index, 1);
    w.detach();
    s.available -= w.tokens;
    const ticket = makeTicket(s, w.deployment, w, t, index);
    s.stats.admitted += 1;
    if (ticket.queued) { s.stats.queued += 1; s.stats.totalWaitMs += ticket.waitedMs; s.stats.maxWaitMs = Math.max(s.stats.maxWaitMs, ticket.waitedMs); }
    if (index > 0) s.stats.jumped += 1;
    w.resolve(ticket);
  }

  function schedule(s, t) {
    if (s.timer) { clearTimer(s.timer); s.timer = null; }
    if (!s.waiters.length) return;
    let delay;
    if (t < s.pausedUntil) delay = s.pausedUntil - t;
    else {
      const head = s.waiters[0];
      const candidates = t - head.enqueuedAt >= agingMs ? [head] : s.waiters;
      delay = Math.min(...candidates.map(w => {
        const need = w.tokens > s.limit ? s.limit : w.tokens;
        return Math.max(0, need - s.available) * 60000 / s.limit;
      }));
      // Re-check when the head crosses the aging threshold so the policy
      // switch is visible in snapshots even if nothing else happens.
      if (t - head.enqueuedAt < agingMs) delay = Math.min(delay, agingMs - (t - head.enqueuedAt));
    }
    s.timer = setTimer(() => { s.timer = null; pump(s); }, Math.max(20, Math.ceil(delay) + 5));
    s.timer?.unref?.();
  }

  function pump(s) {
    const t = now();
    refill(s, t);
    if (t < s.pausedUntil) { schedule(s, t); return; }
    let progressed = true;
    while (progressed && s.waiters.length) {
      progressed = false;
      const head = s.waiters[0];
      if (t - head.enqueuedAt >= agingMs) {
        if (fits(s, head.tokens)) { admit(s, 0, t); progressed = true; }
      } else {
        for (let i = 0; i < s.waiters.length; i++) {
          if (fits(s, s.waiters[i].tokens)) { admit(s, i, t); progressed = true; break; }
        }
      }
    }
    schedule(s, t);
  }

  function state(deployment, limit) {
    let s = states.get(deployment);
    if (!s) { s = fresh(limit); states.set(deployment, s); return s; }
    if (s.limit !== limit) {
      refill(s, now());
      s.limit = limit;
      s.available = Math.min(limit, s.available);
    }
    return s;
  }

  return {
    acquire({ deployment, tokensPerMinute, estimatedTokens, estimatedInputTokens = estimatedTokens, signal, info = {}, onQueued }) {
      const tokens = Math.max(1, Math.ceil(estimatedTokens));
      if (!(tokensPerMinute > 0)) {
        const existing = states.get(deployment);
        // Budget switched off: release anything still waiting on the old one.
        if (existing?.waiters.length) {
          const t = now();
          while (existing.waiters.length) admit(existing, 0, t);
          existing.limit = 0;
        }
        return Promise.resolve({ deployment, tokens, waitedMs: 0, queued: false, jumpedAhead: 0, freestyle: true, settle() {} });
      }
      if (signal?.aborted) return Promise.reject(new BridgeError('Request cancelled by the client', 499));
      const s = state(deployment, tokensPerMinute);
      return new Promise((resolve, reject) => {
        const w = { id: nextId++, deployment, tokens, estimatedInputTokens, enqueuedAt: now(), info, resolve, reject, detach: () => {} };
        const onAbort = () => {
          const i = s.waiters.indexOf(w);
          if (i < 0) return;
          s.waiters.splice(i, 1);
          s.stats.cancelled += 1;
          reject(new BridgeError('Request cancelled by the client while queued', 499));
          pump(s);
        };
        if (signal) { signal.addEventListener('abort', onAbort, { once: true }); w.detach = () => signal.removeEventListener('abort', onAbort); }
        s.waiters.push(w);
        pump(s);
        if (s.waiters.includes(w)) onQueued?.({ position: s.waiters.indexOf(w) + 1, tokens, available: s.available, limit: s.limit });
      });
    },

    pause(deployment, ms) {
      const s = states.get(deployment);
      if (!s || !(s.limit > 0) || !(ms > 0)) return;
      refill(s, now());
      s.pausedUntil = Math.max(s.pausedUntil, now() + ms);
      s.available = Math.min(s.available, 0);
      s.stats.throttled += 1;
      schedule(s, now());
    },

    snapshot() {
      const t = now();
      return [...states.entries()].map(([deployment, s]) => {
        refill(s, t);
        const head = s.waiters[0];
        return {
          deployment, limit: s.limit, available: Math.floor(s.available),
          pausedForMs: Math.max(0, s.pausedUntil - t),
          waiting: s.waiters.map((w, i) => ({ id: w.id, ...w.info, tokens: w.tokens, waitedMs: t - w.enqueuedAt, priority: i === 0 && t - head.enqueuedAt >= agingMs, oversized: w.tokens > s.limit })),
          stats: { ...s.stats },
        };
      });
    },
  };
}
