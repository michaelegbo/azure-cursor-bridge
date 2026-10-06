import { app, BrowserWindow, ipcMain, clipboard, shell } from 'electron';
import net from 'node:net';
import { appendFile, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { createSecrets } from './secrets.mjs';
import { createRuntime } from './runtime.mjs';
import { createCodexSwitch } from './codex-switch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const icon = path.join(here, 'icon.png');
const bridgeRoot = app.isPackaged ? path.join(process.resourcesPath, 'bridge') : path.resolve(here, '..');
function defaultStateDir() {
  if (process.env.CODEX_BRIDGE_STATE_DIR) return process.env.CODEX_BRIDGE_STATE_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA, 'CodexCursorProxy');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'CodexCursorProxy');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'CodexCursorProxy');
}
const state = defaultStateDir();
await mkdir(state, { recursive: true });
const codexSwitch = createCodexSwitch({ stateDir: state, assetsDir: here });
const { settings, EFFORTS, FAST_SUPPORTED } = await import(pathToFileURL(path.join(bridgeRoot, 'src/model-settings.mjs')).href);
const { MODELS } = await import(pathToFileURL(path.join(bridgeRoot, 'src/azure-adapter.mjs')).href);
const { codexCliPath, chatgptAccountDir } = await import(pathToFileURL(path.join(bridgeRoot, 'src/chatgpt-cli-adapter.mjs')).href);
const { claudeAccountDir, claudeCliPath: findClaudeCli } = await import(pathToFileURL(path.join(bridgeRoot, 'src/claude-cli-adapter.mjs')).href);
const { appSettings, normalizeAppSettings, DEFAULT_CUSTOM_MODELS, BLOAT_LEVEL_IDS } = await import(pathToFileURL(path.join(bridgeRoot, 'src/app-settings.mjs')).href);
const { openDb } = await import(pathToFileURL(path.join(bridgeRoot, 'src/db.mjs')).href);

let win;
let lifecycle = Promise.resolve();
let lifecycleAction = '';
const primaryInstance = app.requestSingleInstanceLock();

async function lifecycleLog(message) {
  try { await appendFile(path.join(state, 'lifecycle.log'), `${new Date().toISOString()} ${message}\n`); } catch {}
}
async function json(name) {
  try { return JSON.parse((await readFile(path.join(state, name), 'utf8')).replace(/^﻿/, '')); } catch { return null; }
}
const newKeyValue = () => 'ccp_' + randomBytes(32).toString('base64url');
async function ensureConfig() {
  if (await json('config.json')) return;
  await writeFile(path.join(state, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 17834, apiKey: newKeyValue() }, null, 2));
}

// Windows only: keep the MSIX-virtualized shadow copy of the state dir in sync
// so a bridge launched under an MSIX app context sees the same credentials.
// Only for the real state dir: an app started on another one (tests, a second
// profile) must never overwrite the real bridge's shadow copy.
const mirrorState = process.platform === 'win32' && !process.env.CODEX_BRIDGE_STATE_DIR ? path.join(process.env.LOCALAPPDATA, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Local', 'CodexCursorProxy') : null;
async function mirrorWrite(name, text) {
  if (!mirrorState || !existsSync(mirrorState)) return;
  try { await writeFile(path.join(mirrorState, name), text); } catch {}
}

const secrets = createSecrets(state);
const runtime = createRuntime({ stateDir: state, bridgeRoot, secrets, log: lifecycleLog, tunnelPrefs: () => (db ? appSettings(db) : {}) });
let db;

async function health() {
  const config = await json('config.json');
  if (!config?.port) return null;
  try { return await (await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2000) })).json(); } catch { return null; }
}
async function liveQueue() {
  const config = await json('config.json');
  if (!config?.port || !config.apiKey) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${config.port}/bridge/queue`, { headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function runLifecycle(action) {
  await lifecycleLog(`${action} requested`);
  if (action === 'stop') {
    await runtime.stop();
    const result = await health();
    if (result?.service === 'azure-cursor-bridge') throw Error('The bridge is still responding after stop.');
    await lifecycleLog('stop complete');
    return 'Bridge stopped';
  }
  // 'tunnel' re-applies the public URL settings (keeps a matching tunnel);
  // 'tunnel-reconnect' always reconnects it.
  if (action === 'tunnel' || action === 'tunnel-reconnect') {
    const status = await runtime.restartTunnel({ force: action === 'tunnel-reconnect' });
    await lifecycleLog(`${action} (${status.tunnel.mode || 'failed'})`);
    return tunnelMessage('Public URL updated', status);
  }
  // 'restart-all' (port change): the tunnel must follow the proxy to the new port.
  if (action === 'restart-all') await runtime.stop();
  else if (action === 'restart') await runtime.stopProxy();
  const status = await runtime.start();
  const result = await health();
  if (result?.service !== 'azure-cursor-bridge') throw Error('The bridge started but the local health check failed.');
  await lifecycleLog(`${action} healthy`);
  return tunnelMessage(action === 'start' ? 'Bridge started' : 'Bridge restarted', status);
}
function tunnelMessage(base, status) {
  if (status?.tunnel?.ok === false) return `${base} locally. Public URL failed: ${status.tunnel.error}`;
  if (status?.tunnel?.mode === 'off') return `${base} — local only (public URL is off in Settings).`;
  if (status?.tunnel?.note) return `${base}. ${status.tunnel.note}`;
  return base;
}

function queueLifecycle(action) {
  const queued = lifecycle.then(async () => {
    lifecycleAction = action;
    try { return await runLifecycle(action); }
    finally { lifecycleAction = ''; }
  });
  lifecycle = queued.catch(() => {});
  return queued;
}

// Azure list prices (Global Standard, USD per 1M tokens) as of September 2026.
// Shown as editable defaults; the user's own agreement/region rates override.
const DEFAULT_PRICING = {
  'azure-astra': { input: 10, cachedInput: 1, output: 50 },
  // Fast mode: OpenAI bills it at 2x; Azure's priority rate isn't published
  // per model, so the multiplier is an editable estimate.
  'azure-sol': { input: 2, cachedInput: 0.2, output: 10, fastMultiplier: 2 },
  'azure-opus': { input: 5, cachedInput: 0.5, output: 25 },
};
const maskKey = v => v ? `${v.slice(0, 8)}…${v.slice(-4)}` : '';
const mask4 = v => v ? `${v.slice(0, 4)}…${v.slice(-4)}` : 'unknown';
const keyStatus = k => k.enabled === false ? 'disabled' : (k.expiresAt && Date.now() > Date.parse(k.expiresAt) ? 'expired' : 'active');

function aggregatePeriods() {
  return { today: db.usageAggregate(1), week: db.usageAggregate(7), month: db.usageAggregate(30), all: db.usageAggregate(null) };
}

const CUSTOM_MODEL_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;
// Built-in models the owner removed; the proxy filters the same list.
const hiddenBuiltins = () => (db.settingGet('hidden-builtins') || []).filter(id => MODELS.some(m => m.id === id));
function modelRegistry() {
  const saved = settings(db.settingGet('model-settings') || {});
  const hidden = hiddenBuiltins();
  const builtins = MODELS.filter(m => !hidden.includes(m.id)).map(m => ({ ...m, ...saved[m.id], defaultEffort: saved[m.id].effort, builtin: true, fastSupported: FAST_SUPPORTED.has(m.id) }));
  const taken = new Set(builtins.flatMap(m => [m.id, m.deployment]));
  const custom = (db.settingGet('custom-models') || []).filter(m => m && !taken.has(m.id));
  return [...builtins, ...custom.map(m => ({ ...m, builtin: false, fast: m.fast === true, fastSupported: ['responses', 'chat'].includes(m.protocol) }))];
}
ipcMain.handle('azure:models', async (_e, cmd) => {
  const action = cmd?.action;
  const custom = db.settingGet('custom-models') || [];
  if (action === 'save-builtin') {
    const id = String(cmd.model?.id || '');
    if (!MODELS.some(m => m.id === id)) throw Error('Built-in model not found');
    const current = db.settingGet('model-settings') || {};
    const validated = settings({ ...current, [id]: {
      ...(current[id] || {}),
      effort: cmd.model.defaultEffort,
      maxOutputTokens: cmd.model.maxOutputTokens,
      tokensPerMinute: cmd.model.tokensPerMinute,
    } });
    db.settingSet('model-settings', validated);
    return { message: `Model “${id}” settings saved — they apply to the next request.` };
  }
  if (action === 'restore-builtins') {
    const restored = hiddenBuiltins();
    db.settingDelete('hidden-builtins');
    return { message: restored.length ? `Restored ${restored.join(', ')}.` : 'All built-in models are already listed.' };
  }
  if (action === 'delete') {
    const id = String(cmd.id || '');
    if (MODELS.some(m => m.id === id)) {
      db.settingSet('hidden-builtins', [...new Set([...hiddenBuiltins(), id])]);
      return { message: `Built-in model “${id}” removed. Requests to it now fail closed; “Restore built-in models” brings it back.` };
    }
    if (!custom.some(m => m.id === id)) throw Error('Model not found');
    db.settingSet('custom-models', custom.filter(m => m.id !== id));
    return { message: `Model “${id}” removed. Requests to it now fail closed.` };
  }
  if (action === 'save') {
    const id = String(cmd.model?.id || '').trim().toLowerCase();
    if (!CUSTOM_MODEL_ID.test(id)) throw Error('Model id must be 2-40 lowercase letters, digits or dashes');
    if (EFFORT_SUFFIX.test(id)) throw Error('Model id must not end in an effort suffix (-low, -medium, -high, -xhigh, -max)');
    const builtinTaken = new Set(MODELS.flatMap(m => [m.id, m.deployment]));
    if (builtinTaken.has(id)) throw Error('That id is reserved by a built-in model');
    const deployment = String(cmd.model?.deployment || '').trim();
    if (!deployment || deployment.length > 80) throw Error('Enter the Azure deployment name');
    const protocol = cmd.model?.protocol;
    if (!['responses', 'anthropic', 'chat', 'claude-cli', 'chatgpt'].includes(protocol)) throw Error('Pick the API protocol: responses (OpenAI models), anthropic (Claude on Azure), chat (chat-completions-only deployments like model-router), or claude-cli (your Claude subscription via the Claude CLI)');
    const contextWindow = Number(cmd.model?.contextWindow);
    if (!Number.isInteger(contextWindow) || contextWindow < 1000 || contextWindow > 10000000) throw Error('Context window must be between 1,000 and 10,000,000 tokens');
    const maxOutputTokens = Number(cmd.model?.maxOutputTokens);
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 128000) throw Error('Max output must be between 256 and 128,000 tokens');
    const tokensPerMinute = Number(cmd.model?.tokensPerMinute ?? 0);
    if (!Number.isInteger(tokensPerMinute) || (tokensPerMinute !== 0 && tokensPerMinute < 1000) || tokensPerMinute > 100000000) throw Error('Tokens per minute must be 0 (off) or between 1,000 and 100,000,000');
    const defaultEffort = EFFORTS.includes(cmd.model?.defaultEffort) ? cmd.model.defaultEffort : 'medium';
    const prior = custom.find(m => m.id === id);
    const fast = ['responses', 'chat'].includes(protocol) && (cmd.model?.fast ?? prior?.fast) === true;
    const entry = { id, deployment, label: String(cmd.model?.label || '').trim().slice(0, 60) || id, protocol, contextWindow, maxOutputTokens, tokensPerMinute, defaultEffort, fast };
    const existing = custom.findIndex(m => m.id === id);
    if (existing >= 0) custom[existing] = entry; else custom.push(entry);
    db.settingSet('custom-models', custom);
    return { message: `Model “${id}” saved — it is live on the next request (add it in Cursor's model list to use it there)` };
  }
  throw Error('Unknown models action');
});

async function azureKeyInfo() {
  const azure = await json('azure.json');
  let manifest = db.settingGet('azure-key-manifest');
  if (!manifest && secrets.has('azure-key')) {
    const value = await secrets.get('azure-key');
    manifest = { active: 1, versions: [{ v: 1, createdAt: new Date().toISOString(), fingerprint: mask4(value), endpoint: azure?.endpoint || '', note: 'Existing key imported' }] };
    if (!secrets.has('azure-key-v1')) await secrets.set('azure-key-v1', value);
    db.settingSet('azure-key-manifest', manifest);
  }
  // Versions created before endpoints were versioned inherit the current endpoint.
  if (manifest && manifest.versions.some(v => v.endpoint === undefined)) {
    for (const v of manifest.versions) if (v.endpoint === undefined) v.endpoint = azure?.endpoint || '';
    db.settingSet('azure-key-manifest', manifest);
  }
  return { endpoint: azure?.endpoint || '', active: manifest?.active || null, versions: (manifest?.versions || []).map(v => ({ ...v, isActive: v.v === manifest.active })) };
}
const ENDPOINT_PATTERN = /^https:\/\/[a-z0-9-]+\.(cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/;
async function applyAzureConfig(endpoint, keyValue) {
  const text = JSON.stringify({ endpoint });
  await writeFile(path.join(state, 'azure.json'), text);
  await mirrorWrite('azure.json', text);
  await secrets.set('azure-key', keyValue);
}

async function testAzureKey(keyValue, endpointOverride) {
  const azure = await json('azure.json');
  const endpoint = endpointOverride || azure?.endpoint;
  if (!endpoint) throw Error('No Azure endpoint is configured yet — set it below first.');
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${endpoint}/openai/responses?api-version=2025-04-01-preview`, { method: 'POST', headers: { 'content-type': 'application/json', 'api-key': keyValue }, body: JSON.stringify({ model: 'gpt-6-astra', input: 'Say OK', max_output_tokens: 16, stream: false, store: false }), signal: AbortSignal.timeout(60000) });
  } catch (error) {
    return { ok: false, message: `Could not reach Azure: ${String(error.message).slice(0, 150)}` };
  }
  if (response.ok) return { ok: true, message: `Key is valid — Azure accepted it in ${((Date.now() - started) / 1000).toFixed(1)}s` };
  const body = await response.json().catch(() => null);
  const reason = body?.error?.message || `HTTP ${response.status}`;
  return { ok: false, message: (response.status === 401 || response.status === 403 ? `Key rejected by Azure: ${reason}` : `Azure error (key may still be valid): ${reason}`).slice(0, 300) };
}

// ── Settings page: public URL (Cloudflare), bridge server, tools, local data ──
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TUNNEL_TOKEN = /^[A-Za-z0-9_=+/-]{40,4096}$/;
async function mirrorRemove(name) { if (mirrorState) await rm(path.join(mirrorState, name), { force: true, recursive: true }).catch(() => {}); }
async function tunnelConfigInfo() {
  const named = await json('named-tunnel.json');
  return { hostname: named?.hostname || '', hasToken: secrets.has('tunnel-token'), tunnelName: named?.tunnelName || '' };
}
function systemInfo() {
  const s = appSettings(db);
  const claude = claudeExe(), codex = codexExe();
  const loginItemSupported = process.platform === 'win32' || process.platform === 'darwin';
  return {
    platform: process.platform,
    version: app.getVersion(),
    loginItemSupported,
    openAtLogin: loginItemSupported ? app.getLoginItemSettings().openAtLogin : false,
    claudeCli: { path: claude, found: existsSync(claude), custom: Boolean(s.claudeCliPath) },
    codexCli: { path: codex || '', found: Boolean(codex), custom: Boolean(s.codexCliPath) },
  };
}
const fileSize = p => { try { return statSync(p).size; } catch { return 0; } };
function dataInfo() {
  const file = path.join(state, 'bridge.db');
  return { dir: state, file, bytes: fileSize(file) + fileSize(`${file}-wal`), ...db.stats() };
}
async function writeConfig(cfg) {
  const text = JSON.stringify(cfg, null, 2);
  await writeFile(path.join(state, 'config.json'), text);
  await mirrorWrite('config.json', text);
}
function saveAppSettings(patch) {
  const next = normalizeAppSettings({ ...appSettings(db), ...patch });
  db.settingSet('app-settings', next);
  return next;
}

ipcMain.handle('azure:tunnel', async (_e, cmd) => {
  const action = cmd?.action;
  if (action === 'reconnect') return { message: await queueLifecycle('tunnel-reconnect') };
  if (action === 'remove') {
    await rm(path.join(state, 'named-tunnel.json'), { force: true });
    await mirrorRemove('named-tunnel.json');
    await secrets.remove('tunnel-token');
    await rm(path.join(state, 'tunnel-token.dpapi'), { force: true }); // legacy copy would be re-imported
    if (appSettings(db).tunnelMode === 'named') saveAppSettings({ tunnelMode: 'auto' });
    return { message: `Cloudflare tunnel removed from this bridge. ${await queueLifecycle('tunnel')}` };
  }
  if (action !== 'save') throw Error('Unknown tunnel action');
  const mode = ['auto', 'named', 'quick', 'off'].includes(cmd.mode) ? cmd.mode : 'auto';
  const hostname = String(cmd.hostname || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  if (hostname && !HOSTNAME.test(hostname)) throw Error('Enter just the hostname, for example bridge.example.com');
  // Accept the token alone or the whole "cloudflared service install <token>" command.
  const rawToken = String(cmd.token || '').trim();
  const token = rawToken ? rawToken.split(/\s+/).filter(t => TUNNEL_TOKEN.test(t)).pop() : '';
  if (rawToken && !token) throw Error('That does not look like a Cloudflare tunnel token. Paste the long token from the tunnel’s install command in the Cloudflare dashboard.');
  const current = await tunnelConfigInfo();
  if (mode === 'named' && !((hostname || current.hostname) && (token || current.hasToken))) throw Error('To use your own Cloudflare tunnel, enter both its public hostname and its tunnel token.');
  const prior = await json('named-tunnel.json') || {};
  const hostChanged = Boolean(hostname) && hostname !== current.hostname;
  if (hostChanged) {
    const text = JSON.stringify({ ...prior, hostname }, null, 2);
    await writeFile(path.join(state, 'named-tunnel.json'), text);
    await mirrorWrite('named-tunnel.json', text);
  }
  if (token) await secrets.set('tunnel-token', token);
  const before = appSettings(db);
  saveAppSettings({ tunnelMode: mode, tunnelFallback: cmd.fallback !== false });
  if (!hostChanged && !token && before.tunnelMode === mode) return { message: 'Saved.' };
  return { message: await queueLifecycle(hostChanged || token ? 'tunnel-reconnect' : 'tunnel') };
});

ipcMain.handle('azure:server', async (_e, cmd) => {
  if (cmd?.action === 'login-item') {
    if (!(process.platform === 'win32' || process.platform === 'darwin')) throw Error('On Linux, add Azure Cursor Bridge to your desktop’s startup applications instead.');
    app.setLoginItemSettings({ openAtLogin: cmd.enabled === true });
    return { message: cmd.enabled ? 'The bridge will start when you sign in to this computer.' : 'The bridge will no longer start at sign-in.' };
  }
  if (cmd?.action !== 'port') throw Error('Unknown server action');
  const port = Number(cmd.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('The port must be a whole number between 1024 and 65535.');
  const cfg = await json('config.json');
  if (cfg.port === port) return { message: `The bridge already uses port ${port}.` };
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(Error(`Port ${port} is already in use on this computer. Pick another.`)));
    probe.once('listening', () => probe.close(resolve));
    probe.listen(port, '127.0.0.1');
  });
  await writeConfig({ ...cfg, port });
  const message = await queueLifecycle('restart-all');
  const { hostname } = await tunnelConfigInfo();
  return { message: `${message} Now on port ${port}.${hostname ? ` In the Cloudflare dashboard, point your tunnel’s public hostname at http://localhost:${port}.` : ''} If Codex is in bridge mode, switch it off and on again.` };
});

ipcMain.handle('azure:app-settings', async (_e, patch) => {
  const p = patch || {};
  const clean = {};
  if ('analyzerModel' in p) {
    if (!modelRegistry().some(m => m.id === p.analyzerModel)) throw Error('Pick one of the bridge models for request analysis.');
    clean.analyzerModel = p.analyzerModel;
  }
  if ('bloatLevel' in p) {
    if (!BLOAT_LEVEL_IDS.includes(p.bloatLevel)) throw Error('Choose a bloat remover level.');
    clean.bloatLevel = p.bloatLevel;
  }
  if ('bloatModel' in p) {
    if (!modelRegistry().some(m => m.id === p.bloatModel)) throw Error('Pick one of the bridge models to write the summaries.');
    clean.bloatModel = p.bloatModel;
  }
  for (const k of ['claudeCliPath', 'codexCliPath']) if (k in p) {
    const v = String(p[k] || '').trim();
    if (v && !(existsSync(v) && statSync(v).isFile())) throw Error(`No program found at ${v}`);
    clean[k] = v;
  }
  for (const [k, min, max, name] of [['requestHistoryLimit', 50, 10000, 'Request history'], ['breakdownLimit', 10, 1000, 'Request breakdowns']]) if (k in p) {
    const n = Number(p[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw Error(`${name} must be between ${min} and ${max}.`);
    clean[k] = n;
  }
  saveAppSettings(clean);
  db.applyHistoryLimits();
  if ('claudeCliPath' in clean) claudeAccounts.clearCache();
  if ('codexCliPath' in clean) chatgptAccounts.clearCache();
  return { message: 'Settings saved. They apply to the next request.' };
});

const DATA_PARTS = ['requests', 'usage', 'preferences', 'models', 'guestKeys', 'claudeAccounts', 'chatgptAccounts', 'azure', 'tunnel'];
ipcMain.handle('azure:data', async (_e, cmd) => {
  if (cmd?.action === 'open-folder') {
    const error = await shell.openPath(state);
    if (error) throw Error(error);
    return { message: 'Opened the data folder.' };
  }
  if (cmd?.action === 'compact') return { message: db.compact() ? 'Database compacted.' : 'The bridge is busy writing right now. Try again in a moment.' };
  if (cmd?.action !== 'clear') throw Error('Unknown data action');
  const parts = [...new Set((cmd.parts || []).filter(p => DATA_PARTS.includes(p)))];
  if (!parts.length) throw Error('Choose what to clear.');
  const before = appSettings(db);
  if (parts.includes('requests')) db.clearRequests();
  if (parts.includes('usage')) db.clearUsage();
  if (parts.includes('preferences')) for (const k of ['model-settings', 'pricing', 'app-settings']) db.settingDelete(k);
  if (parts.includes('models')) {
    db.settingSet('custom-models', DEFAULT_CUSTOM_MODELS.map(m => ({ ...m })));
    db.settingDelete('hidden-builtins');
  }
  if (parts.includes('guestKeys')) db.clearGuestKeys();
  if (parts.includes('claudeAccounts')) await claudeAccounts.removeAll();
  if (parts.includes('chatgptAccounts')) await chatgptAccounts.removeAll();
  if (parts.includes('azure')) {
    const manifest = db.settingGet('azure-key-manifest');
    for (const v of manifest?.versions || []) await secrets.remove(`azure-key-v${v.v}`);
    await secrets.remove('azure-key');
    for (const name of ['azure.json', 'azure-key.dpapi', 'azure-key-versions']) {
      await rm(path.join(state, name), { force: true, recursive: true });
      await mirrorRemove(name);
    }
    db.settingDelete('azure-key-manifest');
  }
  if (parts.includes('tunnel')) {
    await rm(path.join(state, 'named-tunnel.json'), { force: true });
    await mirrorRemove('named-tunnel.json');
    await secrets.remove('tunnel-token');
    await rm(path.join(state, 'tunnel-token.dpapi'), { force: true });
  }
  if (parts.includes('preferences')) { claudeAccounts.clearCache(); chatgptAccounts.clearCache(); }
  db.compact();
  // The proxy holds the Azure key in memory, so clearing it needs a restart;
  // tunnel changes only need the public URL re-applied.
  let lifecycleNote = '';
  if (parts.includes('azure')) lifecycleNote = await queueLifecycle('restart');
  else if (parts.includes('tunnel') || (parts.includes('preferences') && before.tunnelMode !== 'auto')) lifecycleNote = await queueLifecycle('tunnel');
  return { message: `Cleared: ${parts.length} item${parts.length > 1 ? 's' : ''}.${lifecycleNote ? ` ${lifecycleNote}` : ''}` };
});

ipcMain.handle('azure:snapshot', async () => {
  const tunnel = await json('tunnel.json'), startStatus = await json('start-status.json'), config = await json('config.json'), result = await health();
  return {
    settings: settings(db.settingGet('model-settings') || {}),
    running: result?.service === 'azure-cursor-bridge',
    busy: lifecycleAction,
    baseUrl: tunnel?.baseUrl || '',
    localUrl: config?.port ? `http://127.0.0.1:${config.port}/v1` : '',
    mode: tunnel?.mode || '',
    tunnelName: tunnel?.tunnelName || '',
    tunnel: startStatus?.tunnel || null,
    tunnelNote: tunnel?.note || '',
    tunnelConfig: await tunnelConfigInfo(),
    appSettings: appSettings(db),
    system: systemInfo(),
    data: dataInfo(),
    models: modelRegistry(),
    codex: process.platform === 'win32' ? await codexSwitch.status().catch(error => ({ enabled: false, error: error.message })) : { enabled: false, error: 'Codex switching is currently available on Windows.' },
    codexRestart: await readFile(path.join(state, 'codex-restart-status.txt'), 'utf8').catch(() => ''),
    claudeCli: claudeAccounts.summary(),
    chatgpt: chatgptAccounts.summary(),
    azureKey: await azureKeyInfo(),
    pricing: db.settingGet('pricing') || DEFAULT_PRICING,
    pricingIsDefault: !db.settingGet('pricing'),
    hiddenBuiltins: hiddenBuiltins(),
    usageTotals: aggregatePeriods(),
    usageDays: db.usageDaily(30),
    queueLive: await liveQueue(),
    queueStats: { today: db.queueAggregate(1), week: db.queueAggregate(7) },
    apiKeys: [{ id: 'owner', label: 'Owner key', masked: maskKey(config?.apiKey), permanent: true, status: 'active' }, ...db.guestList().map(k => ({ id: k.id, label: k.label, masked: maskKey(k.key), status: keyStatus(k), expiresAt: k.expiresAt || null, requests: k.requests || 0, lastUsedAt: k.lastUsedAt || null, history: (k.history || []).map(h => ({ v: h.v, createdAt: h.createdAt, masked: maskKey(h.key) })) }))],
    requests: db.listRequests(100),
  };
});

ipcMain.handle('azure:codex-switch', async (_e, enabled) => {
  if (process.platform !== 'win32') throw Error('Codex switching is currently available on Windows.');
  if (typeof enabled !== 'boolean') throw Error('Choose bridge mode on or off.');
  const current = await codexSwitch.status();
  if (current.enabled === enabled) return { ...current, message: 'Codex is already in this mode.' };
  if (enabled) {
    const config = await json('config.json');
    if (!config?.apiKey) throw Error('The bridge owner key is missing.');
    const result = await health();
    if (result?.service !== 'azure-cursor-bridge') throw Error('Start the bridge before switching Codex to it.');
    // Codex already has the ChatGPT plan models natively.
    const models = modelRegistry().filter(m => m.protocol !== 'chatgpt');
    await codexSwitch.enable(models, Number(config.port));
    await mirrorWrite('codex-model-catalog.json', await readFile(path.join(state, 'codex-model-catalog.json'), 'utf8'));
    var switchNote = '';
  } else { var switchNote = (await codexSwitch.disable()).note || ''; }
  const { spawn } = await import('node:child_process');
  const statusPath = path.join(state, 'codex-restart-status.txt');
  await writeFile(statusPath, 'Restart pending');
  const helper = path.join(here, 'restart-codex.ps1');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper, '-StatusPath', statusPath], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { enabled, message: `Codex will restart now. ${enabled ? 'Bridge models' : 'Your previous OpenAI models'} will be available when it reopens.${switchNote ? ` ${switchNote}` : ''}` };
});

// Merge per model so saving one field (effort, fast) never resets the others.
ipcMain.handle('azure:settings', async (_e, value) => {
  const current = db.settingGet('model-settings') || {};
  const merged = { ...current };
  for (const [id, v] of Object.entries(value || {})) merged[id] = { ...(current[id] || {}), ...v };
  const validated = settings(merged);
  db.settingSet('model-settings', validated);
  return validated;
});

ipcMain.handle('azure:pricing', async (_e, value) => {
  const known = new Set(modelRegistry().map(m => m.id));
  const clean = {};
  for (const [id, v] of Object.entries(value || {})) {
    if (!known.has(id)) continue;
    clean[id] = {};
    for (const f of ['input', 'cachedInput', 'output']) {
      const n = Number(v?.[f]);
      if (!Number.isFinite(n) || n < 0 || n > 100000) throw Error('Rates must be numbers between 0 and 100000 (US dollars per 1 million tokens)');
      clean[id][f] = n;
    }
    if (v?.fastMultiplier !== undefined && v.fastMultiplier !== '' && v.fastMultiplier !== null) {
      const m = Number(v.fastMultiplier);
      if (!Number.isFinite(m) || m < 1 || m > 10) throw Error('The fast-mode rate multiplier must be between 1 and 10');
      clean[id].fastMultiplier = m;
    }
  }
  if (!Object.keys(clean).length) throw Error('No valid model rates were provided');
  db.settingSet('pricing', clean);
  return clean;
});

ipcMain.handle('azure:test', async (_e, payload) => {
  const config = await json('config.json');
  if (!config?.apiKey) throw Error('Bridge is not installed.');
  const known = new Set(modelRegistry().map(m => m.id));
  const model = known.has(payload?.model) ? payload.model : [...known][0];
  const prompt = String(payload?.prompt || '').trim().slice(0, 4000);
  if (!prompt) throw Error('Enter a prompt to test.');
  let base = `http://127.0.0.1:${config.port || 17834}/v1`;
  if (payload?.target === 'public') {
    const tunnel = await json('tunnel.json');
    if (!tunnel?.baseUrl) throw Error('The tunnel is not running, so the public URL cannot be tested.');
    base = tunnel.baseUrl;
  }
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, 'x-bridge-client': 'Playground' }, body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(300000) });
  } catch (error) {
    throw Error(`Could not reach ${base}: ${error.message}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Error(body?.error?.message || `The bridge responded with HTTP ${response.status}.`);
  return { text: body?.choices?.[0]?.message?.content || '', usage: body?.usage || null, durationMs: Date.now() - started, base, model };
});

ipcMain.handle('azure:request-detail', async (_e, id) => {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) throw Error('Invalid request id');
  const detail = db.getDetail(id);
  if (!detail) throw Error('No breakdown was captured for this request. Breakdowns are kept for the most recent 60 requests.');
  detail.result = db.listRequests(200).find(r => r.id === id) || null;
  return detail;
});

// The model that explains requests (Settings → Tools); any bridge model works.
function analyzerModel() {
  const models = modelRegistry();
  const chosen = appSettings(db).analyzerModel;
  if (models.some(m => m.id === chosen)) return chosen;
  // Fall back to a subscription model (no Azure needed), then anything.
  return (models.find(m => m.protocol === 'claude-cli') || models[0])?.id;
}
ipcMain.handle('azure:analyze', async (_e, payload) => {
  const id = String(payload?.id || '');
  if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid request id');
  const detail = db.getDetail(id);
  if (!detail) throw Error('No breakdown was captured for this request.');
  if (detail.analysis?.text && !payload?.force) return detail.analysis.text;
  const config = await json('config.json');
  const result = db.listRequests(200).find(r => r.id === id) || null;
  const summary = { client: detail.client, via: detail.via, userAgent: detail.userAgent, model: detail.model, protocol: detail.protocol, effort: detail.effort, requestBytes: detail.bytes, estimatedInputTokens: detail.estTokens, categories: detail.categories, exactUsage: result?.usage || null, status: result?.status, durationMs: result?.durationMs };
  let previews = '';
  for (const m of detail.messages || []) {
    const line = `- [${m.cat}] ${m.role} (${m.chars} chars): ${m.preview.slice(0, 220).replace(/\s+/g, ' ')}\n`;
    if (previews.length + line.length > 7000) break;
    previews += line;
  }
  const prompt = `You are analyzing one LLM API request that passed through the owner's local proxy ("Azure Cursor Bridge"). The bridge is a pure pass-through: it stores no prompts upstream and caches nothing; "cached tokens" are Azure's own prompt-cache discount on repeated prefixes, not the bridge.\n\nExplain to the bridge owner, in plain language and under 200 words: which client sent this request, what made up the input (system prompt vs tool definitions vs conversation history vs tool results), why the input token count is the size it is, how much Azure served from its prompt cache, and 2-3 practical observations. Character counts are estimates (about 4 chars per token).\n\nRequest summary JSON:\n${JSON.stringify(summary)}\n\nMessage previews (truncated):\n${previews}`;
  const response = await fetch(`http://127.0.0.1:${config.port || 17834}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, 'x-bridge-client': 'Bridge analyzer' }, body: JSON.stringify({ model: analyzerModel(), stream: false, reasoning_effort: 'low', messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(300000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Error(body?.error?.message || `Analysis failed: HTTP ${response.status}`);
  const text = body?.choices?.[0]?.message?.content || '';
  detail.analysis = { at: new Date().toISOString(), text };
  delete detail.result;
  db.saveDetail(id, detail);
  return text;
});

ipcMain.handle('azure:keys', async (_e, cmd) => {
  const action = cmd?.action;
  if (action === 'create') {
    const label = String(cmd.label || 'Guest').slice(0, 40).trim() || 'Guest';
    const hours = Number(cmd.hours) || 0;
    const entry = { id: randomUUID(), label, key: newKeyValue(), enabled: true, createdAt: new Date().toISOString(), expiresAt: hours > 0 ? new Date(Date.now() + hours * 3600000).toISOString() : null, requests: 0 };
    db.guestUpsert(entry);
    clipboard.writeText(entry.key);
    return { message: `Guest key “${label}” created — copied to the clipboard` };
  }
  if (action === 'rotate-owner') {
    const cfg = await json('config.json');
    cfg.apiKey = newKeyValue();
    const text = JSON.stringify(cfg, null, 2);
    await writeFile(path.join(state, 'config.json'), text);
    await mirrorWrite('config.json', text);
    clipboard.writeText(cfg.apiKey);
    return { message: 'Owner key rotated and copied. The old key stops working now — paste the new key into Cursor (OpenAI API key) and update AZURE_CURSOR_BRIDGE_API_KEY for Codex.' };
  }
  if (action === 'copy' && cmd?.id === 'owner') { clipboard.writeText((await json('config.json')).apiKey); return { message: 'Owner key copied' }; }
  const k = db.guestList().find(x => x.id === cmd?.id);
  if (!k) throw Error('Key not found');
  if (action === 'copy') { clipboard.writeText(k.key); return { message: `Key “${k.label}” copied` }; }
  if (action === 'toggle') { k.enabled = k.enabled === false; db.guestUpsert(k); return { message: k.enabled ? `Key “${k.label}” turned on` : `Key “${k.label}” turned off — requests with it are rejected from now` }; }
  if (action === 'reset') {
    const history = k.history || [];
    history.push({ v: Math.max(0, ...history.map(h => h.v)) + 1, key: k.key, createdAt: k.createdAt });
    k.history = history; k.key = newKeyValue(); k.requests = 0; k.createdAt = new Date().toISOString(); k.lastUsedAt = null;
    db.guestUpsert(k); clipboard.writeText(k.key);
    return { message: `Key “${k.label}” reset — new value copied; the old value is kept as v${history.at(-1).v} and can be reverted to` };
  }
  if (action === 'revert') {
    const target = (k.history || []).find(h => h.v === Number(cmd.v));
    if (!target) throw Error('That key version does not exist');
    const history = k.history || [];
    history.push({ v: Math.max(0, ...history.map(h => h.v)) + 1, key: k.key, createdAt: k.createdAt });
    k.history = history; k.key = target.key; k.createdAt = new Date().toISOString();
    db.guestUpsert(k); clipboard.writeText(k.key);
    return { message: `Key “${k.label}” reverted to v${target.v} — value copied; it works on the next request` };
  }
  if (action === 'delete') { db.guestDelete(k.id); return { message: `Key “${k.label}” deleted` }; }
  throw Error('Unknown keys action');
});

ipcMain.handle('azure:azure-key', async (_e, cmd) => {
  const action = cmd?.action;
  const info = await azureKeyInfo();
  const manifest = db.settingGet('azure-key-manifest');
  if (action === 'set') {
    // A version snapshots BOTH the endpoint and the key. Either may change;
    // whichever is omitted carries over from the active configuration.
    let endpoint = String(cmd.endpoint || '').trim().replace(/\/+$/, '');
    let value = String(cmd.value || '').trim();
    if (!endpoint && !value) throw Error('Enter a new key, a new endpoint, or both');
    if (endpoint && !ENDPOINT_PATTERN.test(endpoint)) throw Error('Enter the resource origin, e.g. https://your-resource.services.ai.azure.com');
    if (value && (value.length < 20 || /\s/.test(value))) throw Error('That does not look like an Azure API key');
    if (!endpoint) endpoint = info.endpoint;
    if (!endpoint) throw Error('No endpoint configured yet — enter the Azure endpoint too');
    if (!value) {
      value = await secrets.get('azure-key');
      if (!value) throw Error('No key stored yet — paste the Azure API key too');
    }
    const versions = manifest?.versions || [];
    const next = Math.max(0, ...versions.map(x => x.v)) + 1;
    await secrets.set(`azure-key-v${next}`, value);
    versions.push({ v: next, createdAt: new Date().toISOString(), fingerprint: mask4(value), endpoint, note: cmd.note ? String(cmd.note).slice(0, 60) : 'Added manually' });
    db.settingSet('azure-key-manifest', { active: next, versions });
    await applyAzureConfig(endpoint, value);
    const restart = await queueLifecycle('restart');
    return { message: `Azure configuration v${next} saved and activated. ${restart}.` };
  }
  if (!manifest) throw Error('No Azure key is stored yet — configure the endpoint and key first');
  const version = cmd?.v ? manifest.versions.find(x => x.v === Number(cmd.v)) : manifest.versions.find(x => x.v === manifest.active);
  if (!version) throw Error(`Version ${cmd?.v} does not exist`);
  const secretName = cmd?.v ? `azure-key-v${Number(cmd.v)}` : 'azure-key';
  const readSecret = async () => { const v = await secrets.get(secretName); if (!v) throw Error('Could not decrypt that key version'); return v; };
  if (action === 'reveal') return { value: await readSecret(), endpoint: version.endpoint || info.endpoint, v: version.v };
  if (action === 'copy') { clipboard.writeText(await readSecret()); return { message: cmd?.v ? `Key v${cmd.v} copied` : 'Active Azure key copied' }; }
  if (action === 'test') return await testAzureKey(await readSecret(), version.endpoint || info.endpoint);
  if (action === 'activate') {
    const v = Number(cmd.v);
    const value = await secrets.get(`azure-key-v${v}`);
    if (!value) throw Error('Could not decrypt that key version');
    manifest.active = v;
    db.settingSet('azure-key-manifest', manifest);
    await applyAzureConfig(version.endpoint || info.endpoint, value);
    const restart = await queueLifecycle('restart');
    return { message: `Reverted to Azure configuration v${v} (endpoint + key). ${restart}.` };
  }
  if (action === 'delete') {
    const v = Number(cmd.v);
    if (v === manifest.active) throw Error('The active version cannot be deleted — activate another version first');
    manifest.versions = manifest.versions.filter(x => x.v !== v);
    db.settingSet('azure-key-manifest', manifest);
    return { message: `Azure configuration v${v} deleted` };
  }
  throw Error('Unknown Azure key action');
});

// CLI locations: a path set in Settings → Tools wins, else auto-detected.
const claudeExe = () => findClaudeCli(appSettings(db).claudeCliPath);
const codexExe = () => codexCliPath(appSettings(db).codexCliPath);
// Saved subscription accounts for the Claude CLI (Claude plans) and the Codex
// CLI (ChatGPT plans). 'default' is this computer's own CLI login; every other
// account keeps a separate login in its own folder under the state dir
// (selected with the CLI's config-dir variable), so adding or switching never
// signs Claude Code or the Codex app out. The proxy uses the active account.
const execFileP = async (file, args, env) => {
  const { execFile } = await import('node:child_process');
  return new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: 15000, env }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })));
};
async function openTerminal(title, bin, args, extraEnv) {
  const { spawn } = await import('node:child_process');
  const env = { ...process.env, ...extraEnv };
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', title, 'cmd', '/k', bin, ...args], { detached: true, windowsHide: false, env }).unref();
  } else if (process.platform === 'darwin') {
    const command = [...Object.entries(extraEnv).map(([k, v]) => `${k}=${q(v)}`), ...[bin, ...args].map(q)].join(' ');
    spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`, '-e', 'tell application "Terminal" to activate'], { detached: true }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', 'env', ...Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`), bin, ...args], { detached: true, env }).unref();
  }
}
function createCliAccounts({ key, name, envVar, dirFor, exe, notFound, readStatus, loginArgs, logoutArgs }) {
  const cache = new Map();
  const saved = () => (db.settingGet(`${key}-accounts`) || []).filter(a => a && dirFor(a.id));
  const all = () => [{ id: 'default', label: 'This computer' }, ...saved()];
  const activeId = () => {
    const id = db.settingGet(`${key}-account-active`) || 'default';
    return all().some(a => a.id === id) ? id : 'default';
  };
  const extraEnv = id => (dirFor(id) ? { [envVar]: dirFor(id) } : {});
  const found = () => { const bin = exe(); return bin && existsSync(bin) ? bin : null; };
  // The CLI's own status command is authoritative. Cached and refreshed
  // off-thread; polled faster while a login terminal is open.
  function auth(id) {
    let c = cache.get(id);
    if (!c) cache.set(id, c = { at: 0, checked: false, checking: false, loggedIn: false, account: null, watchUntil: 0, watchFrom: '' });
    const ttl = Date.now() < c.watchUntil ? 4000 : 30000;
    const bin = found();
    if (bin && Date.now() - c.at > ttl && !c.checking) {
      c.checking = true;
      readStatus(bin, { ...process.env, ...extraEnv(id) }, id).then(r => {
        c.loggedIn = Boolean(r.loggedIn);
        c.account = r.loggedIn ? r.account : null;
        c.checked = true;
        if (c.watchUntil && JSON.stringify(c.account) !== c.watchFrom) c.watchUntil = 0;
      }).catch(() => {}).finally(() => { c.at = Date.now(); c.checking = false; });
    }
    return c;
  }
  function summary() {
    const active = activeId();
    const accounts = all().map(a => {
      const c = auth(a.id);
      return { id: a.id, label: a.label, active: a.id === active, checked: c.checked, loggedIn: c.loggedIn, account: c.account };
    });
    const current = accounts.find(a => a.active);
    return { installed: Boolean(found()), checked: current.checked, loggedIn: current.loggedIn, account: current.account, active, activeLabel: current.label, accounts };
  }
  async function openLogin(id) {
    const bin = found();
    if (!bin) throw Error(notFound());
    await openTerminal(`Log in with ${name}${dirFor(id) ? ` (${id})` : ''}`, bin, loginArgs, extraEnv(id));
    const c = auth(id);
    c.watchFrom = JSON.stringify(c.account);
    c.watchUntil = Date.now() + 10 * 60000;
    c.at = 0;
  }
  // Sign a saved (non-default) account out and delete its local login folder.
  async function removeLogin(id) {
    const dir = dirFor(id);
    if (!dir) return;
    const bin = found();
    if (bin) await execFileP(bin, logoutArgs, { ...process.env, ...extraEnv(id) });
    await rm(dir, { recursive: true, force: true });
    cache.delete(id);
  }
  async function removeAll() {
    for (const a of saved()) await removeLogin(a.id);
    db.settingDelete(`${key}-accounts`);
    db.settingDelete(`${key}-account-active`);
  }
  async function handle(request) {
    const { action, id, label } = request || {};
    const list = saved();
    if (action === 'login-active') {
      await openLogin(activeId());
      return { message: `A terminal opened with the ${name} login — ${LOGIN_HINT} ${name} models work as soon as you are signed in.` };
    }
    if (action === 'add') {
      if (!found()) throw Error(notFound());
      // The panel names each plan from its signed-in account; this label is
      // only the fallback until the login completes.
      const label2 = String(label || '').trim().slice(0, 40) || `Plan ${list.length + 2}`;
      const base = label2.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'plan';
      let newId = base;
      for (let n = 2; all().some(a => a.id === newId); n++) newId = `${base}-${n}`;
      await mkdir(dirFor(newId), { recursive: true });
      db.settingSet(`${key}-accounts`, [...list, { id: newId, label: label2 }]);
      await openLogin(newId);
      return { message: `A terminal opened to sign in to another ${name} plan — ${LOGIN_HINT} When you are signed in it appears under “Plan in use”; pick it there to switch.` };
    }
    const account = all().find(a => a.id === id);
    if (!account) throw Error(`Unknown ${name} account`);
    if (action === 'use') {
      const c = auth(account.id);
      if (!c.loggedIn) throw Error(`“${account.label}” is not signed in yet — press Log in on it first.`);
      db.settingSet(`${key}-account-active`, account.id);
      const who = [c.account?.email, c.account?.org, c.account?.plan && `${c.account.plan} plan`].filter(Boolean).join(' · ');
      return { message: `${name} models now run on ${who || `“${account.label}”`} from the next request — no restart needed.` };
    }
    if (action === 'login') {
      await openLogin(account.id);
      return { message: `A terminal opened to sign in “${account.label}” — ${LOGIN_HINT}` };
    }
    if (action === 'remove') {
      if (account.id === 'default') throw Error(`This computer’s own ${name} login cannot be removed here.`);
      await removeLogin(account.id);
      db.settingSet(`${key}-accounts`, list.filter(a => a.id !== account.id));
      const wasActive = db.settingGet(`${key}-account-active`) === account.id;
      if (wasActive) db.settingSet(`${key}-account-active`, 'default');
      return { message: `Removed “${account.label}”.${wasActive ? ` ${name} models are back on this computer’s own login.` : ''}` };
    }
    throw Error(`Unknown ${name} account action`);
  }
  return { summary, handle, removeAll, clearCache: () => cache.clear() };
}

const CLAUDE_INSTALL = process.platform === 'win32'
  ? 'Install it first: in PowerShell run  irm https://claude.ai/install.ps1 | iex'
  : 'Install it first: in a terminal run  curl -fsSL https://claude.ai/install.sh | bash';
const LOGIN_HINT = 'finish signing in there (it opens your browser; choose the account or organization you want).';

const claudeAccounts = createCliAccounts({
  key: 'claude', name: 'Claude', envVar: 'CLAUDE_CONFIG_DIR',
  dirFor: id => claudeAccountDir(state, id),
  exe: claudeExe,
  notFound: () => `The Claude CLI was not found. ${CLAUDE_INSTALL} — or set its location in Settings → Tools.`,
  loginArgs: ['auth', 'login', '--claudeai'],
  logoutArgs: ['auth', 'logout'],
  readStatus: async (bin, env) => {
    const s = JSON.parse((await execFileP(bin, ['auth', 'status'], env)).stdout);
    return { loggedIn: s.loggedIn, account: { email: s.email || '', org: s.orgName || '', plan: s.subscriptionType || '', method: s.authMethod || '' } };
  },
});

// Which ChatGPT account a Codex login belongs to: the email and plan claims
// of the id_token in that login's auth.json. Tokens themselves are never
// returned or shown.
function codexAccountInfo(home) {
  try {
    const auth = JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8'));
    const idToken = auth?.tokens?.id_token;
    const claims = typeof idToken === 'string' ? JSON.parse(Buffer.from(idToken.split('.')[1] || '', 'base64url').toString('utf8')) : {};
    const openai = claims['https://api.openai.com/auth'] || {};
    return { email: String(claims.email || ''), plan: String(openai.chatgpt_plan_type || ''), activeUntil: String(openai.chatgpt_subscription_active_until || '') };
  } catch { return { email: '', plan: '', activeUntil: '' }; }
}
const chatgptAccounts = createCliAccounts({
  key: 'chatgpt', name: 'ChatGPT', envVar: 'CODEX_HOME',
  dirFor: id => chatgptAccountDir(state, id),
  exe: codexExe,
  notFound: () => 'The Codex CLI was not found. Install the Codex app (or `npm i -g @openai/codex`) — or set its location in Settings → Tools.',
  loginArgs: ['login'],
  logoutArgs: ['logout'],
  readStatus: async (bin, env, id) => {
    const r = await execFileP(bin, ['login', 'status'], env);
    const out = `${r.stdout}\n${r.stderr}`;
    const loggedIn = !r.err && /logged in/i.test(out) && !/not logged in/i.test(out);
    const method = /chatgpt/i.test(out) ? 'chatgpt' : /api key/i.test(out) ? 'api-key' : '';
    const home = chatgptAccountDir(state, id) || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    return { loggedIn, account: { ...codexAccountInfo(home), method } };
  },
});

ipcMain.handle('azure:claude-login', () => claudeAccounts.handle({ action: 'login-active' }));
ipcMain.handle('azure:claude-account', (_e, request) => claudeAccounts.handle(request));
ipcMain.handle('azure:chatgpt-login', () => chatgptAccounts.handle({ action: 'login-active' }));
ipcMain.handle('azure:chatgpt-account', (_e, request) => chatgptAccounts.handle(request));
ipcMain.handle('azure:action', async (_e, action) => {
  if (action === 'copy-key') { clipboard.writeText((await json('config.json')).apiKey); return 'Bridge key copied'; }
  if (action === 'copy-url') {
    const publicBase = (await json('tunnel.json'))?.baseUrl;
    clipboard.writeText(publicBase || `http://127.0.0.1:${(await json('config.json'))?.port || 17834}/v1`);
    return publicBase ? 'URL copied' : 'Local URL copied (the public URL is off or not running)';
  }
  if (action === 'start' || action === 'stop' || action === 'restart') return queueLifecycle(action);
  throw Error('Unknown action');
});

app.setName('Azure Cursor Bridge');
app.setAppUserModelId('com.local.codexcursorbridge');
if (!primaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.show();
    win?.focus();
  });
  app.whenReady().then(async () => {
    await ensureConfig();
    await secrets.migrateLegacy();
    db = openDb(state);
    // Fresh install: start with the Claude and ChatGPT models (no Azure needed).
    if (db.settingGet('custom-models') === null) db.settingSet('custom-models', DEFAULT_CUSTOM_MODELS.map(m => ({ ...m })));
    win = new BrowserWindow({ title: 'Azure Cursor Bridge', icon, width: 1120, height: 780, minWidth: 860, minHeight: 620, backgroundColor: '#111315', autoHideMenuBar: true, webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await win.loadFile(path.join(here, 'renderer.html'));
    queueLifecycle('start').catch(error => win?.webContents.send('azure:lifecycle-error', error.message));
  });
  app.on('window-all-closed', () => app.quit());
}
