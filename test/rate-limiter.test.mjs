import test from 'node:test';
import assert from 'node:assert/strict';
import { createTpmQueue } from '../src/rate-limiter.mjs';

function fakeClock() {
  let t = 0;
  const timers = [];
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimer: h => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > end) break;
        const next = timers.shift();
        t = next.at;
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
    flush,
  };
}
function track(promise) {
  const r = { done: false, ticket: null, error: null };
  promise.then(ticket => { r.done = true; r.ticket = ticket; }, error => { r.done = true; r.error = error; });
  return r;
}
const req = (q, tokens, extra = {}) => track(q.acquire({ deployment: 'astra', tokensPerMinute: 2000, estimatedTokens: tokens, ...extra }));

test('requests that fit go immediately; models without a budget are never queued', async () => {
  const c = fakeClock();
  const q = createTpmQueue(c);
  const a = req(q, 500);
  const free = track(q.acquire({ deployment: 'opus', tokensPerMinute: 0, estimatedTokens: 10_000_000 }));
  await c.flush();
  assert.equal(a.done, true);
  assert.equal(a.ticket.queued, false);
  assert.equal(free.done, true);
  assert.equal(free.ticket.freestyle, true);
});

test('a request that does not fit waits, and a smaller one behind it goes first', async () => {
  const c = fakeClock();
  const q = createTpmQueue(c);
  req(q, 500); req(q, 200); req(q, 800);
  await c.flush();
  assert.equal(q.snapshot()[0].available, 500);
  const big = req(q, 600);
  const small = req(q, 300);
  await c.flush();
  assert.equal(big.done, false, '600 must wait: only 500 left');
  assert.equal(small.done, true, '300 fits in the remaining 500 and goes straight in');
  assert.equal(small.ticket.jumpedAhead, 1);
  // 200 left, needs 600: refills at 2000/min, so 400 more tokens takes 12 s.
  await c.advance(11_000);
  assert.equal(big.done, false);
  await c.advance(1_100);
  assert.equal(big.done, true);
  assert.equal(big.ticket.queued, true);
  assert.ok(big.ticket.waitedMs >= 12_000 && big.ticket.waitedMs < 12_200);
});

test('after waiting 10 seconds the oldest request gets priority, so it cannot starve', async () => {
  const c = fakeClock();
  const q = createTpmQueue({ ...c, agingMs: 10_000 });
  const opts = { deployment: 'sol', tokensPerMinute: 60_000 };
  track(q.acquire({ ...opts, estimatedTokens: 60_000 }));
  const big = track(q.acquire({ ...opts, estimatedTokens: 30_000 }));
  await c.advance(5_000);
  const early = track(q.acquire({ ...opts, estimatedTokens: 4_000 }));
  await c.flush();
  assert.equal(early.done, true, 'before aging, small requests backfill');
  await c.advance(6_000);
  const late = track(q.acquire({ ...opts, estimatedTokens: 1_000 }));
  await c.flush();
  assert.equal(late.done, false, 'after aging, nothing passes the oldest waiter');
  assert.equal(q.snapshot()[0].waiting[0].priority, true);
  // Budget is 7,000 at t=11 s and refills 1 token/ms: 30,000 reached at t=34 s.
  await c.advance(22_900);
  assert.equal(big.done, false);
  await c.advance(200);
  assert.equal(big.done, true);
  assert.equal(late.done, false);
  await c.advance(1_100);
  assert.equal(late.done, true);
});

test('a request bigger than the whole budget goes alone once the budget is full', async () => {
  const c = fakeClock();
  const q = createTpmQueue(c);
  req(q, 1000);
  const huge = req(q, 5000);
  await c.flush();
  assert.equal(huge.done, false);
  assert.equal(q.snapshot()[0].waiting[0].oversized, true);
  await c.advance(30_100);
  assert.equal(huge.done, true, 'admitted when the 2,000 budget refilled completely');
  const next = req(q, 100);
  await c.flush();
  assert.equal(next.done, false, 'the budget is now in debt, so the next request waits');
});

test('a client that disconnects leaves the queue and unblocks the requests behind it', async () => {
  const c = fakeClock();
  const q = createTpmQueue({ ...c, agingMs: 1_000 });
  req(q, 2000);
  const controller = new AbortController();
  const head = req(q, 2000, { signal: controller.signal });
  await c.advance(1_500);
  const behind = req(q, 100);
  await c.flush();
  assert.equal(behind.done, false, 'waiting behind the aged head');
  controller.abort();
  await c.flush();
  assert.equal(head.error?.status, 499);
  // Without the cancelled head it would have waited ~60 s for 2,000 tokens to
  // refill first; now it only needs its own 100 (50 available, 1.5 s more).
  await c.advance(1_600);
  assert.equal(behind.done, true);
  assert.equal(q.snapshot()[0].stats.cancelled, 1);
});

test('an Azure 429 pauses the queue for the Retry-After time', async () => {
  const c = fakeClock();
  const q = createTpmQueue(c);
  req(q, 100);
  await c.flush();
  q.pause('astra', 5_000);
  const waiting = req(q, 100);
  await c.advance(4_000);
  assert.equal(waiting.done, false);
  assert.equal(q.snapshot()[0].pausedForMs, 1_000);
  await c.advance(1_000);
  // Budget was zeroed by the 429; 100 tokens refill in 3 s at 2,000/min.
  await c.advance(3_100);
  assert.equal(waiting.done, true);
  assert.equal(q.snapshot()[0].stats.throttled, 1);
});

test('settling with the real prompt size returns an over-estimate to the budget', async () => {
  const c = fakeClock();
  const q = createTpmQueue(c);
  const first = req(q, 1500, { estimatedInputTokens: 1200 });
  await c.flush();
  const second = req(q, 1000);
  await c.flush();
  assert.equal(second.done, false);
  first.ticket.settle(400);
  await c.flush();
  assert.equal(second.done, true, '800 tokens refunded made room');
});

test('turning a budget off releases everything still waiting', async () => {
  const c = fakeClock();
  const q = createTpmQueue(c);
  req(q, 2000);
  const waiting = req(q, 2000);
  await c.flush();
  assert.equal(waiting.done, false);
  track(q.acquire({ deployment: 'astra', tokensPerMinute: 0, estimatedTokens: 10 }));
  await c.flush();
  assert.equal(waiting.done, true);
});
