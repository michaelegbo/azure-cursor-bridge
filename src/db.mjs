import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

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
  `);
  try { db.exec(`ALTER TABLE guest_keys ADD COLUMN history TEXT`); } catch {}

  const requestToRow = r => ({
    id: r.id, at: r.at, model: r.model ?? null, deployment: r.deployment ?? null,
    protocol: r.protocol ?? null, effort: r.effort ?? null, bytes: r.bytes ?? null,
    status: r.status ?? null, client: r.client ?? null, via: r.via ?? null,
    key_label: r.key ?? null, duration_ms: r.durationMs ?? null,
    input_tokens: r.usage?.inputTokens ?? null, cached_tokens: r.usage?.cachedTokens ?? null,
    output_tokens: r.usage?.outputTokens ?? null, error: r.error ?? null,
    context_window: r.contextWindow ?? null,
  });
  const rowToRequest = row => ({
    id: row.id, at: row.at, model: row.model, deployment: row.deployment,
    protocol: row.protocol, effort: row.effort, bytes: row.bytes, status: row.status,
    client: row.client, via: row.via, key: row.key_label, durationMs: row.duration_ms,
    error: row.error, contextWindow: row.context_window,
    usage: row.input_tokens === null && row.output_tokens === null ? null : {
      inputTokens: row.input_tokens || 0, cachedTokens: row.cached_tokens || 0,
      outputTokens: row.output_tokens || 0,
    },
  });

  const api = {
    upsertRequest(entry) {
      const r = requestToRow(entry);
      db.prepare(`INSERT INTO requests(id,at,model,deployment,protocol,effort,bytes,status,client,via,key_label,duration_ms,input_tokens,cached_tokens,output_tokens,error,context_window)
        VALUES(:id,:at,:model,:deployment,:protocol,:effort,:bytes,:status,:client,:via,:key_label,:duration_ms,:input_tokens,:cached_tokens,:output_tokens,:error,:context_window)
        ON CONFLICT(id) DO UPDATE SET status=:status,duration_ms=:duration_ms,input_tokens=:input_tokens,cached_tokens=:cached_tokens,output_tokens=:output_tokens,error=:error`).run(r);
      db.prepare(`DELETE FROM requests WHERE id NOT IN (SELECT id FROM requests ORDER BY at DESC LIMIT 500)`).run();
    },
    listRequests(limit = 100) {
      return db.prepare(`SELECT * FROM requests ORDER BY at DESC LIMIT ?`).all(limit).map(rowToRequest);
    },
    saveDetail(id, detail) {
      db.prepare(`INSERT INTO request_details(id,at,json) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET json=excluded.json`).run(id, detail.at || new Date().toISOString(), JSON.stringify(detail));
      db.prepare(`DELETE FROM request_details WHERE id NOT IN (SELECT id FROM request_details ORDER BY at DESC LIMIT 60)`).run();
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
    usageAdd(model, usage) {
      const day = new Date().toISOString().slice(0, 10);
      db.prepare(`INSERT INTO usage_daily(day,model,requests,input_tokens,cached_tokens,output_tokens) VALUES(?,?,1,?,?,?)
        ON CONFLICT(day,model) DO UPDATE SET requests=requests+1,input_tokens=input_tokens+excluded.input_tokens,cached_tokens=cached_tokens+excluded.cached_tokens,output_tokens=output_tokens+excluded.output_tokens`)
        .run(day, model, usage.inputTokens || 0, usage.cachedTokens || 0, usage.outputTokens || 0);
    },
    usageAggregate(daysBack) {
      let rows;
      if (daysBack === null) {
        rows = db.prepare(`SELECT model,SUM(requests) requests,SUM(input_tokens) input_tokens,SUM(cached_tokens) cached_tokens,SUM(output_tokens) output_tokens FROM usage_daily GROUP BY model`).all();
      } else {
        const cutoff = new Date(Date.now() - (daysBack - 1) * 86400000).toISOString().slice(0, 10);
        rows = db.prepare(`SELECT model,SUM(requests) requests,SUM(input_tokens) input_tokens,SUM(cached_tokens) cached_tokens,SUM(output_tokens) output_tokens FROM usage_daily WHERE day>=? GROUP BY model`).all(cutoff);
      }
      const res = {};
      for (const r of rows) res[r.model] = {
        requests: r.requests || 0, inputTokens: r.input_tokens || 0,
        cachedTokens: r.cached_tokens || 0, outputTokens: r.output_tokens || 0,
      };
      return res;
    },
    usageDaily(days = 30) {
      const cutoff = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      const rows = db.prepare(`SELECT * FROM usage_daily WHERE day>=? ORDER BY day DESC`).all(cutoff);
      const byDay = new Map();
      for (const r of rows) {
        if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, models: {} });
        byDay.get(r.day).models[r.model] = {
          requests: r.requests || 0, inputTokens: r.input_tokens || 0,
          cachedTokens: r.cached_tokens || 0, outputTokens: r.output_tokens || 0,
        };
      }
      return [...byDay.values()];
    },
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
