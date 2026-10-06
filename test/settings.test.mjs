import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_DEFAULTS, normalizeAppSettings, DEFAULT_CUSTOM_MODELS } from '../src/app-settings.mjs';
import { openDb } from '../src/db.mjs';
import { claudeCliPath } from '../src/claude-cli-adapter.mjs';
import { codexCliPath } from '../src/chatgpt-cli-adapter.mjs';
import { createRuntime } from '../electron/runtime.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'bridge-settings-'));

test('missing or invalid preferences fall back to the defaults', () => {
  assert.deepEqual(normalizeAppSettings(), { ...APP_DEFAULTS });
  const s = normalizeAppSettings({ tunnelMode: 'bogus', tunnelFallback: 'yes', requestHistoryLimit: 5, breakdownLimit: 99999, analyzerModel: '../x', claudeCliPath: 'a\nb' });
  assert.equal(s.tunnelMode, 'auto');
  assert.equal(s.tunnelFallback, true);
  assert.equal(s.requestHistoryLimit, 500);
  assert.equal(s.breakdownLimit, 60);
  assert.equal(s.analyzerModel, 'azure-astra');
  assert.equal(s.claudeCliPath, '');
  assert.equal(normalizeAppSettings({ tunnelMode: 'off', requestHistoryLimit: 2000 }).requestHistoryLimit, 2000);
});

test('the default models are valid custom models that need no Azure deployment', () => {
  const ids = new Set();
  for (const m of DEFAULT_CUSTOM_MODELS) {
    assert.match(m.id, /^[a-z0-9][a-z0-9-]{1,39}$/);
    assert.doesNotMatch(m.id, /-(low|medium|high|xhigh|max)$/);
    assert.ok(['claude-cli', 'chatgpt'].includes(m.protocol), m.id);
    assert.ok(!ids.has(m.id), `duplicate ${m.id}`);
    ids.add(m.id);
  }
  assert.ok(ids.has('bridge-claude-opus') && ids.has('bridge-chatgpt-astra'));
});

test('history limits come from Settings, and each part of the database can be cleared', () => {
  const dir = tmp();
  const db = openDb(dir);
  try {
    db.settingSet('app-settings', { requestHistoryLimit: 50, breakdownLimit: 10 });
    db.applyHistoryLimits();
    for (let i = 0; i < 70; i++) {
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      db.upsertRequest({ id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, at, model: 'm', status: 'ok' });
      db.saveDetail(`d${i}`, { at });
    }
    db.usageAdd('m', { inputTokens: 5, cachedTokens: 0, outputTokens: 1 });
    db.guestUpsert({ id: 'g', label: 'G', key: 'k', createdAt: new Date().toISOString() });
    assert.deepEqual(db.stats(), { requests: 50, breakdowns: 10, usageDays: 1, guestKeys: 1 });
    assert.equal(db.listRequests(1)[0].id.endsWith('69'), true, 'the newest requests are kept');
    db.clearRequests();
    db.clearUsage();
    db.clearGuestKeys();
    db.settingDelete('app-settings');
    assert.deepEqual(db.stats(), { requests: 0, breakdowns: 0, usageDays: 0, guestKeys: 0 });
    assert.equal(db.settingGet('app-settings'), null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the public URL uses your tunnel when configured, else a temporary URL, or none', async () => {
  const dir = tmp();
  const secretsStore = new Map();
  const secrets = { get: async n => secretsStore.get(n) ?? null, has: n => secretsStore.has(n) };
  let prefs = {};
  const runtime = createRuntime({ stateDir: dir, bridgeRoot: dir, secrets, tunnelPrefs: () => prefs });
  try {
    assert.equal((await runtime.tunnelPlan()).mode, 'quick', 'nothing configured: temporary URL');
    writeFileSync(path.join(dir, 'named-tunnel.json'), JSON.stringify({ hostname: 'bridge.example.com' }));
    assert.equal((await runtime.tunnelPlan()).mode, 'quick', 'hostname without a token is not enough');
    secretsStore.set('tunnel-token', 'x'.repeat(60));
    assert.equal((await runtime.tunnelPlan()).mode, 'named', 'hostname + token: your own tunnel');
    prefs = { tunnelMode: 'quick' };
    assert.equal((await runtime.tunnelPlan()).mode, 'quick');
    prefs = { tunnelMode: 'off' };
    assert.equal((await runtime.tunnelPlan()).mode, 'off');
    secretsStore.clear();
    prefs = { tunnelMode: 'named', tunnelFallback: true };
    const plan = await runtime.tunnelPlan();
    assert.equal(plan.mode, 'quick');
    assert.match(plan.note, /temporary public URL/);
    prefs = { tunnelMode: 'named', tunnelFallback: false };
    await assert.rejects(runtime.tunnelPlan(), /No Cloudflare tunnel is configured/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a CLI location set in Settings wins over automatic detection', () => {
  const dir = tmp();
  try {
    const fake = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fake, '');
    assert.equal(claudeCliPath(fake), fake);
    assert.equal(codexCliPath(fake), fake);
    assert.notEqual(claudeCliPath(path.join(dir, 'missing')), path.join(dir, 'missing'), 'a missing override falls back to detection');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
