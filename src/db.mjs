import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { normalizeAppSettings } from './app-settings.mjs';

// Embedded SQLite storage shared by the Electron main process and the proxy
// server child process. WAL mode allows both to read and write concurrently.
export function openDb(stateDir) {
  const db = new DatabaseSync(path.join(stateDir, 'bridge.db'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS requests(
      id TEXT PRIMARY KEY, at TEXT, model TEXT, deployment TEXT, protocol TEXT,
      effort TEXT, bytes INTEGER, status TEXT, client TEXT, via TEXT, key_label TEXT,
      duration_ms INTEGER, input_tokens INTEGER, cached_tokens INTEGER,
      output_tokens INTEGER, error TEXT, context_window INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_requests_at ON requests(at DESC);
    CREATE TABLE IF NOT EXISTS request_details(id TEXT PRIMARY KEY, at TEXT, json TEXT);
    CREATE TABLE IF NOT EXISTS guest_keys(
      id TEXT PRIMARY KEY, label TEXT, key TEXT, enabled INTEGER DEFAULT 1,
      created_at TEXT, expires_at TEXT, requests INTEGER DEFAULT 0, last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS usage_daily(
      day TEXT, model TEXT, requests INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      PRIMARY KEY(day, model)
    );
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS queue_daily(
      day TEXT, model TEXT, admitted INTEGER DEFAULT 0, queued INTEGER DEFAULT 0,
      wait_ms INTEGER DEFAULT 0, max_wait_ms INTEGER DEFAULT 0, jumped INTEGER DEFAULT 0,
      throttled INTEGER DEFAULT 0,
      PRIMARY KEY(day, model)
    );
    CREATE TABLE IF NOT EXISTS trim_summaries(hash TEXT PRIMARY KEY, at TEXT, summary TEXT);
  `);
  try { db.exec(`ALTER TABLE guest_keys ADD COLUMN history TEXT`); } catch {}
  try { db.exec(`ALTER TABLE requests ADD COLUMN queue_ms INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE requests ADD COLUMN queue_jumped INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE requests ADD COLUMN tier_requested TEXT`); } catch {}
  try { db.exec(`ALTER TABLE requests ADD COLUMN tier_served TEXT`); } catch {}
  for (const col of ['fast_input_tokens', 'fast_cached_tokens', 'fast_output_tokens']) {
    try { db.exec(`ALTER TABLE usage_daily ADD COLUMN ${col} INTEGER DEFAULT 0`); } catch {}
  }
  const usageRow = r => ({
    requests: r.requests || 0, inputTokens: r.input_tokens || 0,
    cachedTokens: r.cached_tokens || 0, outputTokens: r.output_tokens || 0,
    fastInputTokens: r.fast_input_tokens || 0, fastCachedTokens: r.fast_cached_tokens || 0,
    fastOutputTokens: r.fast_output_tokens || 0,
  });

  const requestToRow = r => ({
    id: r.id, at: r.at, model: r.model ?? null, deployment: r.deployment ?? null,
    protocol: r.protocol ?? null, effort: r.effort ?? null, bytes: r.bytes ?? null,
    status: r.status ?? null, client: r.client ?? null, via: r.via ?? null,
    key_label: r.key ?? null, duration_ms: r.durationMs ?? null,
    input_tokens: r.usage?.inputTokens ?? null, cached_tokens: r.usage?.cachedTokens ?? null,
    output_tokens: r.usage?.outputTokens ?? null, error: r.error ?? null,
    context_window: r.contextWindow ?? null,
    queue_ms: r.queueMs ?? null, queue_jumped: r.queueJumped ?? null,
    tier_requested: r.tierRequested ?? null, tier_served: r.tierServed ?? null,
  });
  const rowToRequest = row => ({
    id: row.id, at: row.at, model: row.model, deployment: row.deployment,
    protocol: row.protocol, effort: row.effort, bytes: row.bytes, status: row.status,
    client: row.client, via: row.via, key: row.key_label, durationMs: row.duration_ms,
    error: row.error, contextWindow: row.context_window,
    queueMs: row.queue_ms ?? null, queueJumped: row.queue_jumped ?? null,
    tierRequested: row.tier_requested ?? null, tierServed: row.tier_served ?? null,
    usage: row.input_tokens === null && row.output_tokens === null ? null : {
      inputTokens: row.input_tokens || 0, cachedTokens: row.cached_tokens || 0,
      outputTokens: row.output_tokens || 0,
    },
  });

  // History caps come from Settings; re-read at most every 5 s.
  let limitsCache = { at: 0, value: null };
  const limits = () => {
    if (Date.now() - limitsCache.at > 5000) {
      let raw = null;
      try { const row = db.prepare(`SELECT value FROM settings WHERE key='app-settings'`).get(); raw = row ? JSON.parse(row.value) : null; } catch {}
      limitsCache = { at: Date.now(), value: normalizeAppSettings(raw || {}) };
    }
    return limitsCache.value;
  };
  const pruneRequests = () => db.prepare(`DELETE FROM requests WHERE id NOT IN (SELECT id FROM requests ORDER BY at DESC LIMIT ?)`).run(limits().requestHistoryLimit);
  const pruneDetails = () => db.prepare(`DELETE FROM request_details WHERE id NOT IN (SELECT id FROM request_details ORDER BY at DESC LIMIT ?)`).run(limits().breakdownLimit);

  const api = {
    upsertRequest(entry) {
      const r = requestToRow(entry);
      db.prepare(`INSERT INTO requests(id,at,model,deployment,protocol,effort,bytes,status,client,via,key_label,duration_ms,input_tokens,cached_tokens,output_tokens,error,context_window,queue_ms,queue_jumped,tier_requested,tier_served)
        VALUES(:id,:at,:model,:deployment,:protocol,:effort,:bytes,:status,:client,:via,:key_label,:duration_ms,:input_tokens,:cached_tokens,:output_tokens,:error,:context_window,:queue_ms,:queue_jumped,:tier_requested,:tier_served)
        ON CONFLICT(id) DO UPDATE SET status=:status,duration_ms=:duration_ms,input_tokens=:input_tokens,cached_tokens=:cached_tokens,output_tokens=:output_tokens,error=:error,queue_ms=:queue_ms,queue_jumped=:queue_jumped,tier_served=:tier_served`).run(r);
      pruneRequests();
    },
    listRequests(limit = 100) {
      return db.prepare(`SELECT * FROM requests ORDER BY at DESC LIMIT ?`).all(limit).map(rowToRequest);
    },
    saveDetail(id, detail) {
      db.prepare(`INSERT INTO request_details(id,at,json) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET json=excluded.json`).run(id, detail.at || new Date().toISOString(), JSON.stringify(detail));
      pruneDetails();
    },
    getDetail(id) {
      const row = db.prepare(`SELECT json FROM request_details WHERE id=?`).get(id);
      return row ? JSON.parse(row.json) : null;
    },
    guestList() {
      return db.prepare(`SELECT * FROM guest_keys ORDER BY created_at`).all().map(k => ({
        id: k.id, label: k.label, key: k.key, enabled: Boolean(k.enabled),
        createdAt: k.created_at, expiresAt: k.expires_at, requests: k.requests || 0,
        lastUsedAt: k.last_used_at, history: k.history ? JSON.parse(k.history) : [],
      }));
    },
    guestUpsert(k) {
      db.prepare(`INSERT INTO guest_keys(id,label,key,enabled,created_at,expires_at,requests,last_used_at,history)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET label=excluded.label,key=excluded.key,enabled=excluded.enabled,expires_at=excluded.expires_at,requests=excluded.requests,last_used_at=excluded.last_used_at,history=excluded.history`)
        .run(k.id, k.label, k.key, k.enabled === false ? 0 : 1, k.createdAt, k.expiresAt ?? null, k.requests || 0, k.lastUsedAt ?? null, JSON.stringify(k.history || []));
    },
    guestDelete(id) { db.prepare(`DELETE FROM guest_keys WHERE id=?`).run(id); },
    guestTouch(id) {
      db.prepare(`UPDATE guest_keys SET requests=requests+1,last_used_at=? WHERE id=?`).run(new Date().toISOString(), id);
    },
    settingGet(key) {
      const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key);
      return row ? JSON.parse(row.value) : null;
    },
    settingSet(key, value) {
      db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));
    },
    importDay(day, model, u) {
      db.prepare(`INSERT INTO usage_daily(day,model,requests,input_tokens,cached_tokens,output_tokens) VALUES(?,?,?,?,?,?)
        ON CONFLICT(day,model) DO UPDATE SET requests=excluded.requests,input_tokens=excluded.input_tokens,cached_tokens=excluded.cached_tokens,output_tokens=excluded.output_tokens`)
        .run(day, model, u.requests || 0, u.inputTokens || 0, u.cachedTokens || 0, u.outputTokens || 0);
    },
    // Tokens served by Azure's priority (fast) tier are also counted in the
    // fast_* columns so cost estimates can apply the fast-mode rate to them.
    usageAdd(model, usage, tierServed = null) {
      const day = new Date().toISOString().slice(0, 10);
      const fast = tierServed === 'priority';
      db.prepare(`INSERT INTO usage_daily(day,model,requests,input_tokens,cached_tokens,output_tokens,fast_input_tokens,fast_cached_tokens,fast_output_tokens) VALUES(?,?,1,?,?,?,?,?,?)
        ON CONFLICT(day,model) DO UPDATE SET requests=requests+1,input_tokens=input_tokens+excluded.input_tokens,cached_tokens=cached_tokens+excluded.cached_tokens,output_tokens=output_tokens+excluded.output_tokens,fast_input_tokens=fast_input_tokens+excluded.fast_input_tokens,fast_cached_tokens=fast_cached_tokens+excluded.fast_cached_tokens,fast_output_tokens=fast_output_tokens+excluded.fast_output_tokens`)
        .run(day, model, usage.inputTokens || 0, usage.cachedTokens || 0, usage.outputTokens || 0,
          fast ? usage.inputTokens || 0 : 0, fast ? usage.cachedTokens || 0 : 0, fast ? usage.outputTokens || 0 : 0);
    },
    usageAggregate(daysBack) {
      let rows;
      const cols = `model,SUM(requests) requests,SUM(input_tokens) input_tokens,SUM(cached_tokens) cached_tokens,SUM(output_tokens) output_tokens,SUM(fast_input_tokens) fast_input_tokens,SUM(fast_cached_tokens) fast_cached_tokens,SUM(fast_output_tokens) fast_output_tokens`;
      if (daysBack === null) {
        rows = db.prepare(`SELECT ${cols} FROM usage_daily GROUP BY model`).all();
      } else {
        const cutoff = new Date(Date.now() - (daysBack - 1) * 86400000).toISOString().slice(0, 10);
        rows = db.prepare(`SELECT ${cols} FROM usage_daily WHERE day>=? GROUP BY model`).all(cutoff);
      }
      const res = {};
      for (const r of rows) res[r.model] = usageRow(r);
      return res;
    },
    queueRecord(model, ticket) {
      const day = new Date().toISOString().slice(0, 10);
      const waited = Math.max(0, Math.round(ticket.waitedMs || 0));
      db.prepare(`INSERT INTO queue_daily(day,model,admitted,queued,wait_ms,max_wait_ms,jumped) VALUES(?,?,1,?,?,?,?)
        ON CONFLICT(day,model) DO UPDATE SET admitted=admitted+1,queued=queued+excluded.queued,wait_ms=wait_ms+excluded.wait_ms,max_wait_ms=MAX(max_wait_ms,excluded.max_wait_ms),jumped=jumped+excluded.jumped`)
        .run(day, model, ticket.queued ? 1 : 0, waited, waited, ticket.jumpedAhead > 0 ? 1 : 0);
    },
    queueThrottle(model) {
      const day = new Date().toISOString().slice(0, 10);
      db.prepare(`INSERT INTO queue_daily(day,model,throttled) VALUES(?,?,1)
        ON CONFLICT(day,model) DO UPDATE SET throttled=throttled+1`).run(day, model);
    },
    queueAggregate(daysBack) {
      const cutoff = new Date(Date.now() - (daysBack - 1) * 86400000).toISOString().slice(0, 10);
      const res = {};
      for (const r of db.prepare(`SELECT model,SUM(admitted) admitted,SUM(queued) queued,SUM(wait_ms) wait_ms,MAX(max_wait_ms) max_wait_ms,SUM(jumped) jumped,SUM(throttled) throttled FROM queue_daily WHERE day>=? GROUP BY model`).all(cutoff))
        res[r.model] = { admitted: r.admitted || 0, queued: r.queued || 0, waitMs: r.wait_ms || 0, maxWaitMs: r.max_wait_ms || 0, jumped: r.jumped || 0, throttled: r.throttled || 0 };
      return res;
    },
    usageDaily(days = 30) {
      const cutoff = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      const rows = db.prepare(`SELECT * FROM usage_daily WHERE day>=? ORDER BY day DESC`).all(cutoff);
      const byDay = new Map();
      for (const r of rows) {
        if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, models: {} });
        byDay.get(r.day).models[r.model] = usageRow(r);
      }
      return [...byDay.values()];
    },
    // Local data management (Settings → Local database).
    stats() {
      const count = sql => db.prepare(sql).get().c || 0;
      return {
        requests: count(`SELECT COUNT(*) c FROM requests`),
        breakdowns: count(`SELECT COUNT(*) c FROM request_details`),
        usageDays: count(`SELECT COUNT(DISTINCT day) c FROM usage_daily`),
        guestKeys: count(`SELECT COUNT(*) c FROM guest_keys`),
      };
    },
    applyHistoryLimits() { limitsCache.at = 0; pruneRequests(); pruneDetails(); },
    clearRequests() { db.exec(`DELETE FROM requests; DELETE FROM request_details; DELETE FROM trim_summaries;`); },
    // Bloat remover 'deep' summaries, keyed by a hash of the summarized span.
    summaryGet(hash) { return db.prepare(`SELECT summary FROM trim_summaries WHERE hash=?`).get(hash)?.summary || null; },
    summarySet(hash, summary) {
      db.prepare(`INSERT INTO trim_summaries(hash,at,summary) VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET at=excluded.at`).run(hash, new Date().toISOString(), summary);
      db.prepare(`DELETE FROM trim_summaries WHERE hash NOT IN (SELECT hash FROM trim_summaries ORDER BY at DESC LIMIT 200)`).run();
    },
    clearUsage() { db.exec(`DELETE FROM usage_daily; DELETE FROM queue_daily;`); },
    clearGuestKeys() { db.exec(`DELETE FROM guest_keys;`); },
    settingDelete(key) { db.prepare(`DELETE FROM settings WHERE key=?`).run(key); limitsCache.at = 0; },
    // Give freed pages back to the disk; skipped quietly if the proxy is busy writing.
    compact() { try { db.exec(`PRAGMA wal_checkpoint(TRUNCATE); VACUUM;`); return true; } catch { return false; } },
    close() { db.close(); },
  };

  migrateFromJson(api, stateDir);
  return api;
}

// One-time import of the pre-SQLite JSON state files. Originals are left in
// place untouched so a rollback to the previous app version still works.
function migrateFromJson(api, stateDir) {
  if (api.settingGet('json-migrated')) return;
  const readJson = name => {
    try { return JSON.parse(readFileSync(path.join(stateDir, name), 'utf8').replace(/^﻿/, '')); }
    catch { return null; }
  };
  const modelSettings = readJson('model-settings.json');
  if (modelSettings) api.settingSet('model-settings', modelSettings);
  const pricing = readJson('pricing.json');
  if (pricing) api.settingSet('pricing', pricing);
  const keyManifest = readJson('azure-key-versions.json');
  if (keyManifest) api.settingSet('azure-key-manifest', keyManifest);
  for (const k of readJson('api-keys.json')?.keys || []) api.guestUpsert(k);
  const requests = readJson('azure-requests.json');
  if (Array.isArray(requests)) for (const r of requests.reverse()) { try { api.upsertRequest(r); } catch {} }
  const totals = readJson('usage-totals.json');
  if (totals?.days) {
    for (const [day, models] of Object.entries(totals.days)) for (const [model, u] of Object.entries(models)) {
      try { api.importDay(day, model, u); } catch {}
    }
  }
  const detailDir = path.join(stateDir, 'azure-request-details');
  if (existsSync(detailDir)) {
    for (const name of readdirSync(detailDir).slice(-60)) {
      try {
        const detail = JSON.parse(readFileSync(path.join(detailDir, name), 'utf8'));
        if (detail?.id) api.saveDetail(detail.id, detail);
      } catch {}
    }
  }
  api.settingSet('json-migrated', { at: new Date().toISOString() });
}
