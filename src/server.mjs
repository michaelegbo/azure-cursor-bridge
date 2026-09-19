import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createSink, sendJson, sendOpenAIError } from './openai-protocol.mjs';
import { BridgeError } from './errors.mjs';
import { MODELS, routeModel, runAzure } from './azure-adapter.mjs';
import { settings, LIMITS, EFFORTS, resolveEffort } from './model-settings.mjs';
import { openDb } from './db.mjs';

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

const host = '127.0.0.1', port = Number(process.env.AZURE_BRIDGE_PORT || config.port || 17834);
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
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { status: 'ok', service: 'azure-cursor-bridge', modelCount: MODELS.length, version: '3.0.0' });
    const who = await auth(req);
    if (!who) throw new BridgeError('Invalid bridge API key', 401);
    if (req.method === 'GET' && ['/v1/models', '/models'].includes(url.pathname)) return sendJson(res, 200, { object: 'list', data: MODELS.flatMap(m => [{ id: m.id, name: m.label }, ...EFFORTS.map(e => ({ id: `${m.id}-${e}`, name: `${m.label} · ${e}` }))].map(v => ({ id: v.id, object: 'model', created: 1789170000, owned_by: 'azure', name: v.name, context_window: LIMITS[m.id].contextWindow, max_input_tokens: LIMITS[m.id].maxInputTokens, max_output_tokens: 128000, reasoning_efforts: EFFORTS }))) });
    if (req.method !== 'POST' || !['/v1/chat/completions', '/chat/completions', '/v1/responses', '/responses'].includes(url.pathname)) throw new BridgeError('Not found', 404);
    if (!key) throw new BridgeError('No Azure API key is configured. Set it in the bridge app.', 503);
    const endpoint = await azureEndpoint();
    let bytes = 0; const chunks = []; for await (const chunk of req) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new BridgeError('Request too large', 413); chunks.push(chunk); }
    let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { throw new BridgeError('Invalid JSON', 400); }
    const route = routeModel(body.model), protocol = url.pathname.endsWith('/responses') ? 'responses' : 'chat';
    if (body.previous_response_id) throw new BridgeError('Send the full conversation history; previous_response_id is not supported by this stateless bridge.', 400);
    if (protocol === 'chat' && !Array.isArray(body.messages)) throw new BridgeError('messages must be an array', 400);
    let preferences; try { preferences = settings(db.settingGet('model-settings') || {}); } catch { preferences = settings(); }
    const effort = resolveEffort(body, route, preferences);
    entry = { effort, contextWindow: LIMITS[route.id].contextWindow, id: randomUUID(), at: new Date().toISOString(), model: route.id, deployment: route.deployment, protocol, bytes, status: 'running', client: clientLabel(req), via: req.headers['cf-connecting-ip'] ? 'public' : 'local', key: who.label };
    const started = Date.now();
    db.upsertRequest(entry);
    recordDetail(entry, body, req);
    const abort = new AbortController(); res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    sink = createSink(protocol, res, { stream: Boolean(body.stream), onLifecycle: ({ status, error }) => {
      entry.status = status; entry.durationMs = Date.now() - started; entry.usage = sink.session?.usage;
      if (entry.usage && status !== 'running' && !countedEntries.has(entry)) { countedEntries.add(entry); try { db.usageAdd(entry.model, entry.usage); } catch {} }
      if (error) entry.error = String(error.message).replaceAll(key, '[redacted]').slice(0, 500);
      try { db.upsertRequest(entry); } catch {}
    } });
    const heartbeat = setInterval(() => { if (res.headersSent && !res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
    try { await runAzure({ body, protocol, route, key, endpoint, signal: abort.signal, sink, preferences }); } finally { clearInterval(heartbeat); }
  } catch (error) {
    if (entry) { entry.status = 'failed'; entry.error = String(error.message).replaceAll(key || ' ', '[redacted]').slice(0, 500); try { db.upsertRequest(entry); } catch {} }
    if (sink) sink.error(error); else sendOpenAIError(res, error);
  }
});
server.requestTimeout = 0; server.keepAliveTimeout = 75000; server.headersTimeout = 80000;
server.listen(port, host, () => console.log(`Azure Cursor Bridge listening on http://${host}:${port}/v1`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 1000).unref(); });
