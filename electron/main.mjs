import { app, BrowserWindow, ipcMain, clipboard } from 'electron';
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { createSecrets } from './secrets.mjs';
import { createRuntime } from './runtime.mjs';

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
const { settings, LIMITS, EFFORTS } = await import(pathToFileURL(path.join(bridgeRoot, 'src/model-settings.mjs')).href);
const { MODELS } = await import(pathToFileURL(path.join(bridgeRoot, 'src/azure-adapter.mjs')).href);
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
const mirrorState = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Local', 'CodexCursorProxy') : null;
async function mirrorWrite(name, text) {
  if (!mirrorState || !existsSync(mirrorState)) return;
  try { await writeFile(path.join(mirrorState, name), text); } catch {}
}

const secrets = createSecrets(state);
const runtime = createRuntime({ stateDir: state, bridgeRoot, secrets, log: lifecycleLog });
let db;

async function health() {
  const config = await json('config.json');
  if (!config?.port) return null;
  try { return await (await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2000) })).json(); } catch { return null; }
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
  if (action === 'restart') await runtime.stopProxy();
  const status = await runtime.start();
  const result = await health();
  if (result?.service !== 'azure-cursor-bridge') throw Error('The bridge started but the local health check failed.');
  await lifecycleLog(`${action} healthy`);
  const base = action === 'restart' ? 'Bridge restarted' : 'Bridge started';
  if (status?.tunnel?.ok === false) return `${base} locally. Tunnel failed: ${status.tunnel.error}`;
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
function modelRegistry() {
  const builtins = MODELS.map(m => ({ ...m, ...LIMITS[m.id], builtin: true }));
  const taken = new Set(builtins.flatMap(m => [m.id, m.deployment]));
  const custom = (db.settingGet('custom-models') || []).filter(m => m && !taken.has(m.id));
  return [...builtins, ...custom.map(m => ({ ...m, builtin: false }))];
}
ipcMain.handle('azure:models', async (_e, cmd) => {
  const action = cmd?.action;
  const custom = db.settingGet('custom-models') || [];
  if (action === 'delete') {
    const id = String(cmd.id || '');
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
    if (!['responses', 'anthropic', 'chat', 'claude-cli'].includes(protocol)) throw Error('Pick the API protocol: responses (OpenAI models), anthropic (Claude on Azure), chat (chat-completions-only deployments like model-router), or claude-cli (your Claude subscription via the Claude CLI)');
    const contextWindow = Number(cmd.model?.contextWindow) || 1000000;
    if (contextWindow < 1000 || contextWindow > 10000000) throw Error('Context window must be between 1,000 and 10,000,000 tokens');
    const maxOutputTokens = Number(cmd.model?.maxOutputTokens) || 128000;
    if (maxOutputTokens < 256 || maxOutputTokens > 128000) throw Error('Max output must be between 256 and 128,000 tokens');
    const defaultEffort = EFFORTS.includes(cmd.model?.defaultEffort) ? cmd.model.defaultEffort : 'medium';
    const entry = { id, deployment, label: String(cmd.model?.label || '').trim().slice(0, 60) || id, protocol, contextWindow, maxOutputTokens, defaultEffort };
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
    models: modelRegistry(),
    claudeCli: claudeCliStatus(),
    azureKey: await azureKeyInfo(),
    pricing: db.settingGet('pricing') || DEFAULT_PRICING,
    pricingIsDefault: !db.settingGet('pricing'),
    usageTotals: aggregatePeriods(),
    usageDays: db.usageDaily(30),
    apiKeys: [{ id: 'owner', label: 'Owner key', masked: maskKey(config?.apiKey), permanent: true, status: 'active' }, ...db.guestList().map(k => ({ id: k.id, label: k.label, masked: maskKey(k.key), status: keyStatus(k), expiresAt: k.expiresAt || null, requests: k.requests || 0, lastUsedAt: k.lastUsedAt || null, history: (k.history || []).map(h => ({ v: h.v, createdAt: h.createdAt, masked: maskKey(h.key) })) }))],
    requests: db.listRequests(100),
  };
});

ipcMain.handle('azure:settings', async (_e, value) => { const validated = settings(value); db.settingSet('model-settings', validated); return validated; });

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
  }
  if (!Object.keys(clean).length) throw Error('No valid model rates were provided');
  db.settingSet('pricing', clean);
  return clean;
});

ipcMain.handle('azure:test', async (_e, payload) => {
  const config = await json('config.json');
  if (!config?.apiKey) throw Error('Bridge is not installed.');
  const known = new Set(modelRegistry().map(m => m.id));
  const model = known.has(payload?.model) ? payload.model : 'azure-astra';
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
  const response = await fetch(`http://127.0.0.1:${config.port || 17834}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, 'x-bridge-client': 'Bridge analyzer' }, body: JSON.stringify({ model: 'azure-astra', stream: false, reasoning_effort: 'low', messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(300000) });
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

const claudeCliPath = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
// `claude auth status` is authoritative (the CLI keeps its login in the OS
// credential store, not in a readable file). Cached and refreshed off-thread.
const claudeAuthCache = { at: 0, loggedIn: false, checking: false };
function claudeCliStatus() {
  const installed = existsSync(claudeCliPath);
  if (installed && Date.now() - claudeAuthCache.at > 30000 && !claudeAuthCache.checking) {
    claudeAuthCache.checking = true;
    import('node:child_process').then(({ execFile }) => {
      execFile(claudeCliPath, ['auth', 'status'], { windowsHide: true, timeout: 15000 }, (_err, stdout) => {
        try { claudeAuthCache.loggedIn = Boolean(JSON.parse(String(stdout)).loggedIn); } catch {}
        claudeAuthCache.at = Date.now();
        claudeAuthCache.checking = false;
      });
    }).catch(() => { claudeAuthCache.checking = false; });
  }
  return { installed, loggedIn: claudeAuthCache.loggedIn };
}
ipcMain.handle('azure:claude-login', async () => {
  if (!existsSync(claudeCliPath)) throw Error('The Claude CLI is not installed. Install it from https://claude.ai/install.ps1 first.');
  const { spawn } = await import('node:child_process');
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', 'Log in with Claude', 'cmd', '/k', claudeCliPath, '/login'], { detached: true, windowsHide: false }).unref();
  } else if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${claudeCliPath} /login"`], { detached: true }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', `${claudeCliPath} /login`], { detached: true }).unref();
  }
  return { message: 'A terminal opened with the Claude login — finish signing in there (it opens your browser), then Claude CLI models work immediately.' };
});
ipcMain.handle('azure:action', async (_e, action) => {
  if (action === 'copy-key') { clipboard.writeText((await json('config.json')).apiKey); return 'Bridge key copied'; }
  if (action === 'copy-url') { clipboard.writeText((await json('tunnel.json')).baseUrl); return 'URL copied'; }
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
    win = new BrowserWindow({ title: 'Azure Cursor Bridge', icon, width: 1120, height: 780, minWidth: 860, minHeight: 620, backgroundColor: '#111315', autoHideMenuBar: true, webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await win.loadFile(path.join(here, 'renderer.html'));
    queueLifecycle('start').catch(error => win?.webContents.send('azure:lifecycle-error', error.message));
  });
  app.on('window-all-closed', () => app.quit());
}
