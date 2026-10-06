import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createSink, sendJson, sendOpenAIError, openSse } from './openai-protocol.mjs';
import { BridgeError } from './errors.mjs';
import { MODELS, routeModel, runAzure } from './azure-adapter.mjs';
import { runClaudeCli, activeClaudeConfigDir } from './claude-cli-adapter.mjs';
import { runChatgptCli, activeCodexHome } from './chatgpt-cli-adapter.mjs';
import { settings, EFFORTS, resolveEffort, outputLimit, resolveServiceTier } from './model-settings.mjs';
import { createTpmQueue } from './rate-limiter.mjs';
import { openDb } from './db.mjs';
import { appSettings } from './app-settings.mjs';
import { trimBloat } from './bloat.mjs';

function defaultStateDir() {
  if (process.env.CODEX_BRIDGE_STATE_DIR) return process.env.CODEX_BRIDGE_STATE_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA, 'CodexCursorProxy');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'CodexCursorProxy');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'CodexCursorProxy');
}
const stateDir = defaultStateDir();
await mkdir(stateDir, { recursive: true });
const db = openDb(stateDir);
const config = JSON.parse((await readFile(path.join(stateDir, 'config.json'), 'utf8')).replace(/^﻿/, ''));

// The Azure key is injected by the desktop app (which holds it encrypted with
// the OS keystore). The bridge itself never stores it.
const key = (process.env.AZURE_BRIDGE_KEY || '').trim();
const ENDPOINT_PATTERN = /^https:\/\/[a-z0-9-]+\.(cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/;
async function azureEndpoint() {
  let azure;
  try { azure = JSON.parse(await readFile(path.join(stateDir, 'azure.json'), 'utf8')); } catch {}
  if (!azure?.endpoint) throw new BridgeError('No Azure endpoint is configured. Set it in the bridge app.', 503);
  if (!ENDPOINT_PATTERN.test(azure.endpoint)) throw new BridgeError('The configured Azure endpoint is not a recognized Azure AI endpoint.', 503);
  return azure.endpoint;
}

// Built-in models plus user-added models (stored in the database). Custom
// entries never shadow a built-in id or deployment name.
const CUSTOM_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
function registry() {
  const saved = settings(db.settingGet('model-settings') || {});
  const builtins = MODELS.map(m => ({ ...m, ...saved[m.id], defaultEffort: saved[m.id].effort, builtin: true }));
  const taken = new Set(builtins.flatMap(m => [m.id, m.deployment]));
  let custom = [];
  try { custom = db.settingGet('custom-models') || []; } catch {}
  const extras = (Array.isArray(custom) ? custom : [])
    .filter(m => m && CUSTOM_ID.test(m.id || '') && m.deployment && ['responses', 'anthropic', 'chat', 'claude-cli', 'chatgpt'].includes(m.protocol) && !taken.has(m.id))
    .map(m => ({ id: m.id, deployment: String(m.deployment), label: m.label || m.id, protocol: m.protocol, defaultEffort: m.defaultEffort, contextWindow: Number(m.contextWindow) || 1000000, maxInputTokens: m.maxInputTokens ? Number(m.maxInputTokens) : undefined, maxOutputTokens: Number(m.maxOutputTokens) || 128000, tokensPerMinute: Number(m.tokensPerMinute) || 0, fast: m.fast === true, fastSupported: ['responses', 'chat'].includes(m.protocol) }));
  return [...builtins, ...extras];
}

const host = '127.0.0.1', port = Number(process.env.AZURE_BRIDGE_PORT || config.port || 17834);
const tpmQueue = createTpmQueue();
// Streams still waiting (TPM queue or Azure backoff) after this long get
// their SSE headers early plus keepalives: Cloudflare drops a response that
// sends no first byte within 100 seconds.
const HOLD_OPEN_MS = 8000;
if (!process.env.AZURE_BRIDGE_PORT) await writeFile(path.join(stateDir, 'proxy.pid'), String(process.pid));

function clientLabel(req) {
  const explicit = req.headers['x-bridge-client']; if (explicit) return String(explicit).slice(0, 40);
  const ua = String(req.headers['user-agent'] || '');
  if (/cursor/i.test(ua)) return 'Cursor';
  if (/codex/i.test(ua)) return 'Codex';
  if (/openai/i.test(ua)) return 'OpenAI client';
  if (/anthropic|claude/i.test(ua)) return 'Claude client';
  if (!ua) return req.headers['cf-connecting-ip'] ? 'Unknown (public)' : 'Local app';
  return ua.split(/[\/ ]/)[0].slice(0, 24) || 'Unknown';
}

function composition(body, protocol) {
  const cats = { system: { label: 'System & instructions', group: 'scaffolding', chars: 0, count: 0 }, tools: { label: 'Tool definitions', group: 'scaffolding', chars: 0, count: 0 }, user: { label: 'User messages', group: 'conversation', chars: 0, count: 0 }, assistant: { label: 'Assistant history', group: 'conversation', chars: 0, count: 0 }, toolflow: { label: 'Tool calls & results', group: 'conversation', chars: 0, count: 0 } };
  const messages = [];
  const str = v => typeof v === 'string' ? v : JSON.stringify(v ?? '');
  const add = (cat, role, value) => { const s = str(value); cats[cat].chars += s.length; cats[cat].count += 1; if (messages.length < 150) messages.push({ cat, role, chars: s.length, preview: s.slice(0, 400) }); };
  if (protocol === 'chat') {
    for (const m of body.messages || []) {
      if (['system', 'developer'].includes(m.role)) { add('system', m.role, m.content); continue; }
      if (m.role === 'tool') { add('toolflow', 'tool result', m.content); continue; }
      if (m.role === 'assistant') { if (m.content) add('assistant', 'assistant', m.content); for (const c of m.tool_calls || []) add('toolflow', 'tool call', c); continue; }
      add('user', m.role || 'user', m.content);
    }
    for (const t of body.tools || []) add('tools', `tool: ${t?.function?.name || t?.name || 'unnamed'}`, t);
  } else {
    if (body.instructions) add('system', 'instructions', body.instructions);
    const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : (body.input || []);
    for (const item of input) {
      if (item.type === 'function_call') { add('toolflow', 'tool call', item); continue; }
      if (item.type === 'function_call_output') { add('toolflow', 'tool result', item.output); continue; }
      if (item.type === 'reasoning') { add('assistant', 'reasoning', item); continue; }
      const role = item.role || 'user';
      if (['system', 'developer'].includes(role)) add('system', role, item.content);
      else if (role === 'assistant') add('assistant', role, item.content);
      else add('user', role, item.content);
    }
    for (const t of body.tools || []) add('tools', `tool: ${t?.name || t?.function?.name || 'unnamed'}`, t);
  }
  const totalChars = Object.values(cats).reduce((n, c) => n + c.chars, 0);
  for (const c of Object.values(cats)) c.estTokens = Math.ceil(c.chars / 4);
  return { categories: cats, messages, totalChars, estTokens: Math.ceil(totalChars / 4) };
}

function recordDetail(entry, body, req) {
  try {
    const comp = composition(body, entry.protocol);
    db.saveDetail(entry.id, { id: entry.id, at: entry.at, model: entry.model, deployment: entry.deployment, protocol: entry.protocol, effort: entry.effort, bytes: entry.bytes, client: entry.client, via: entry.via, userAgent: String(req.headers['user-agent'] || '').slice(0, 200), remoteIp: String(req.headers['cf-connecting-ip'] || '').slice(0, 60), ...comp });
  } catch {}
}

const countedEntries = new WeakSet();

// 'deep' bloat removal: the summary is written by a bridge model through this
// same bridge (owner key), marked so it is not trimmed itself.
async function summarizeForTrim(prompt, model, signal) {
  let ownerKey = config.apiKey;
  try { ownerKey = JSON.parse((await readFile(path.join(stateDir, 'config.json'), 'utf8')).replace(/^﻿/, '')).apiKey; } catch {}
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json', 'x-bridge-client': 'Bloat remover', 'x-bridge-skip-trim': '1' },
    body: JSON.stringify({ model, stream: false, reasoning_effort: 'low', messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Error(j?.error?.message || `summary model returned HTTP ${r.status}`);
  return j?.choices?.[0]?.message?.content || '';
}

// Keys are re-read on every request so a rotate, disable, reset or expiry
// takes effect immediately without restarting the proxy.
async function auth(req) {
  const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /i, ''));
  const matches = v => { const e = Buffer.from(v || ''); return e.length >= 16 && supplied.length === e.length && timingSafeEqual(supplied, e); };
  let ownerKey = config.apiKey;
  try { ownerKey = JSON.parse((await readFile(path.join(stateDir, 'config.json'), 'utf8')).replace(/^﻿/, '')).apiKey; } catch {}
  if (matches(ownerKey)) return { kind: 'owner', label: 'Owner' };
  for (const k of db.guestList()) {
    if (!matches(k.key)) continue;
    if (k.enabled === false) throw new BridgeError('This bridge key has been turned off', 401);
    if (k.expiresAt && Date.now() > Date.parse(k.expiresAt)) throw new BridgeError('This bridge key has expired', 401);
    db.guestTouch(k.id);
    return { kind: 'guest', label: k.label || 'Guest', id: k.id };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let sink, entry;
  try {
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { status: 'ok', service: 'azure-cursor-bridge', modelCount: registry().length, version: '3.2.0' });
    const who = await auth(req);
    if (!who) throw new BridgeError('Invalid bridge API key', 401);
    if (req.method === 'GET' && url.pathname === '/bridge/queue') {
      if (who.kind !== 'owner') throw new BridgeError('Only the owner key can read the queue', 403);
      const models = registry();
      return sendJson(res, 200, { at: new Date().toISOString(), deployments: tpmQueue.snapshot().map(d => ({ ...d, models: models.filter(m => m.deployment === d.deployment).map(m => m.id) })) });
    }
    if (req.method === 'GET' && ['/v1/models', '/models'].includes(url.pathname)) return sendJson(res, 200, { object: 'list', data: registry().flatMap(m => [{ id: m.id, name: m.label }, ...EFFORTS.map(e => ({ id: `${m.id}-${e}`, name: `${m.label} · ${e}` }))].map(v => ({ id: v.id, object: 'model', created: 1789170000, owned_by: 'azure', name: v.name, context_window: m.contextWindow, max_input_tokens: m.maxInputTokens ?? m.contextWindow, max_output_tokens: m.maxOutputTokens || 128000, tokens_per_minute: m.tokensPerMinute || 0, reasoning_efforts: EFFORTS }))) });
    if (req.method !== 'POST' || !['/v1/chat/completions', '/chat/completions', '/v1/responses', '/responses'].includes(url.pathname)) throw new BridgeError('Not found', 404);
    let bytes = 0; const chunks = []; for await (const chunk of req) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new BridgeError('Request too large', 413); chunks.push(chunk); }
    let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { throw new BridgeError('Invalid JSON', 400); }
    const route = routeModel(body.model, registry()), protocol = url.pathname.endsWith('/responses') ? 'responses' : 'chat';
    let endpoint = null;
    // ChatGPT plans are personal subscriptions, so guest keys can't use them.
    if (route.protocol === 'chatgpt' && who.kind !== 'owner') throw new BridgeError('ChatGPT plan models can only be used with the bridge owner key.', 403);
    if (!['claude-cli', 'chatgpt'].includes(route.protocol)) {
      if (!key) throw new BridgeError('No Azure API key is configured. Set it in the bridge app.', 503);
      endpoint = await azureEndpoint();
    }
    if (body.previous_response_id) throw new BridgeError('Send the full conversation history; previous_response_id is not supported by this stateless bridge.', 400);
    if (protocol === 'chat' && !Array.isArray(body.messages)) throw new BridgeError('messages must be an array', 400);
    let preferences; try { preferences = settings(db.settingGet('model-settings') || {}); } catch { preferences = settings(); }
    const effort = resolveEffort(body, route, preferences);
    const serviceTier = ['responses', 'chat'].includes(route.protocol) ? resolveServiceTier(body, route, preferences) : null;
    let estimatedInputTokens = Math.ceil(bytes / 4);
    entry = { effort, contextWindow: route.contextWindow, id: randomUUID(), at: new Date().toISOString(), model: route.id, deployment: route.deployment, protocol, bytes, status: 'running', client: clientLabel(req), via: req.headers['cf-connecting-ip'] ? 'public' : 'local', key: who.label, tierRequested: serviceTier };
    let started = Date.now();
    let ticket = null;
    db.upsertRequest(entry);
    recordDetail(entry, body, req);
    const abort = new AbortController(); res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    sink = createSink(protocol, res, { stream: Boolean(body.stream), onLifecycle: ({ status, error }) => {
      entry.status = status; entry.durationMs = Date.now() - started; entry.usage = sink.session?.usage;
      if (sink.session?.serviceTier) entry.tierServed = sink.session.serviceTier;
      if (entry.usage && status !== 'running' && !countedEntries.has(entry)) { countedEntries.add(entry); try { db.usageAdd(entry.model, entry.usage, entry.tierServed); } catch {} ticket?.settle(entry.usage); }
      if (error) entry.error = String(error.message).replaceAll(key, '[redacted]').slice(0, 500);
      try { db.upsertRequest(entry); } catch {}
    } });
    const holdOpen = body.stream ? setTimeout(() => { if (!res.headersSent && !res.writableEnded) { openSse(res); res.write(': waiting for token budget\n\n'); } }, HOLD_OPEN_MS) : null;
    const heartbeat = setInterval(() => { if (res.headersSent && !res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
    try {
      // Bloat remover (Settings → Bloat remover): trims old tool output and
      // history before the request is queued or sent upstream. A problem here
      // never fails the request; it just goes through untrimmed.
      const trimPrefs = appSettings(db);
      if (trimPrefs.bloatLevel !== 'off' && !req.headers['x-bridge-skip-trim']) {
        try {
          const trimmed = await trimBloat(body, protocol, trimPrefs.bloatLevel, {
            summarize: trimPrefs.bloatLevel === 'deep' ? prompt => summarizeForTrim(prompt, trimPrefs.bloatModel, abort.signal) : null,
            cache: { get: k => db.summaryGet(k), set: (k, v) => db.summarySet(k, v) },
          });
          if (trimmed.stats) {
            body = trimmed.body;
            estimatedInputTokens = Math.max(1, estimatedInputTokens - Math.floor((trimmed.stats.beforeChars - trimmed.stats.afterChars) / 4));
            const detail = db.getDetail(entry.id);
            if (detail) db.saveDetail(entry.id, { ...detail, trim: trimmed.stats });
          }
        } catch {}
      }
      // Models with a TPM budget wait here until their estimated tokens fit;
      // models without one pass straight through.
      ticket = await tpmQueue.acquire({
        deployment: route.deployment,
        tokensPerMinute: route.tokensPerMinute,
        estimatedTokens: estimatedInputTokens + outputLimit(body, route),
        estimatedInputTokens,
        signal: abort.signal,
        info: { model: route.id, client: entry.client, requestId: entry.id },
        onQueued: () => { entry.status = 'queued'; try { db.upsertRequest(entry); } catch {} },
      });
      if (!ticket.freestyle) {
        entry.queueMs = ticket.waitedMs;
        entry.queueJumped = ticket.jumpedAhead;
        try { db.queueRecord(route.id, ticket); } catch {}
      }
      entry.status = 'running';
      started = Date.now();
      try { db.upsertRequest(entry); } catch {}
      const onThrottle = ms => { tpmQueue.pause(route.deployment, ms); if (route.tokensPerMinute > 0) { try { db.queueThrottle(route.id); } catch {} } };
      if (route.protocol === 'claude-cli') await runClaudeCli({ body, protocol, route, effort, sink, signal: abort.signal, stateDir, configDir: activeClaudeConfigDir(db, stateDir), cliPath: appSettings(db).claudeCliPath });
      else if (route.protocol === 'chatgpt') await runChatgptCli({ body, protocol, route, effort, sink, signal: abort.signal, stateDir, cliPath: appSettings(db).codexCliPath, codexHome: activeCodexHome(db, stateDir) });
      else await runAzure({ body, protocol, route, key, endpoint, signal: abort.signal, sink, preferences, onThrottle, serviceTier });
    } finally { clearInterval(heartbeat); clearTimeout(holdOpen); }
  } catch (error) {
    if (entry) { entry.status = 'failed'; entry.error = String(error.message).replaceAll(key || ' ', '[redacted]').slice(0, 500); try { db.upsertRequest(entry); } catch {} }
    if (sink) sink.error(error); else sendOpenAIError(res, error);
  }
});
server.requestTimeout = 0; server.keepAliveTimeout = 75000; server.headersTimeout = 80000;
server.listen(port, host, () => console.log(`Azure Cursor Bridge listening on http://${host}:${port}/v1`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 1000).unref(); });
