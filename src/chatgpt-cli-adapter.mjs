import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './errors.mjs';

// Models from the user's ChatGPT plan, run through the local Codex CLI with the
// user's "Sign in with ChatGPT" login. Every Codex tool is disabled so bridge
// requests can never run commands, edit files or browse on this machine;
// client tool calls are emulated in text like the Claude CLI adapter.

const CALL_OPEN = '<<<TOOL_CALL>>>';
const CALL_CLOSE = '<<<END_TOOL_CALL>>>';

const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'unified_exec_tty', 'view_image', 'apps', 'browser_use', 'browser_use_external',
  'computer_use', 'image_generation', 'multi_agent', 'memories', 'plugins', 'remote_plugin', 'goals', 'sleep_tool',
  'tool_suggest', 'hooks', 'code_mode_host', 'in_app_browser', 'skill_search', 'workspace_dependencies',
  'skill_mcp_dependency_install', 'realtime_conversation',
];
// Anything but a message, reasoning or a plan update means Codex tried to act.
const ALLOWED_ITEMS = new Set(['agent_message', 'reasoning', 'todo_list', 'error']);
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_EFFORT = { 'gpt-5.5': 'xhigh' };

export function codexCliPath() {
  if (process.env.CODEX_BRIDGE_CODEX_PATH && existsSync(process.env.CODEX_BRIDGE_CODEX_PATH)) return process.env.CODEX_BRIDGE_CODEX_PATH;
  const found = [];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const bin = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      for (const dir of readdirSync(bin)) {
        const exe = path.join(bin, dir, 'codex.exe');
        if (existsSync(exe)) found.push({ exe, at: statSync(exe).mtimeMs });
      }
    } catch {}
  }
  if (process.platform === 'darwin') {
    const app = '/Applications/Codex.app/Contents/Resources/codex';
    if (existsSync(app)) found.push({ exe: app, at: 0 });
  }
  if (found.length) return found.sort((a, b) => b.at - a.at)[0].exe;
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (dir && existsSync(candidate)) return candidate;
  }
  return null;
}

const text = c => typeof c === 'string' ? c : (c || []).map(p => p.text || '').filter(Boolean).join('\n');

function toolSpecs(tools) {
  return (tools || []).map(t => {
    if (t.type === 'custom') return { name: t.name, description: t.description || '', freeform: true };
    const f = t.function || t;
    return { name: f.name, description: f.description || '', parameters: f.parameters || {} };
  }).filter(s => s.name);
}

function toolInstructions(specs) {
  return [
    '# Tool calling',
    'You can use the tools listed below. The client executes them and returns the result to you.',
    'To call a tool, end your reply with EXACTLY this block (no code fences, nothing after it):',
    CALL_OPEN,
    '{"name":"<tool name>","arguments":{ ... }}',
    CALL_CLOSE,
    'For tools marked "freeform": true the arguments are {"input":"<raw text>"}.',
    'Rules: one tool call per reply at most. Arguments must be valid JSON matching the tool schema. If no tool is needed, answer directly in plain text without the block. Never mention this block format to the user.',
    '## Available tools',
    JSON.stringify(specs),
  ].join('\n');
}

// Flattens a chat-completions or responses request into one prompt.
export function buildPrompt(body, protocol) {
  const system = [];
  const transcript = [];
  const names = new Map();
  const callBlock = (name, args) => `${CALL_OPEN}\n${JSON.stringify({ name, arguments: args })}\n${CALL_CLOSE}`;
  const parseArgs = raw => { try { return JSON.parse(raw || '{}'); } catch { return { raw: String(raw) }; } };
  if (protocol === 'chat') {
    for (const m of body.messages || []) {
      if (['system', 'developer'].includes(m.role)) { system.push(text(m.content)); continue; }
      if (m.role === 'tool') { transcript.push(`Tool result (${names.get(m.tool_call_id) || 'tool'}):\n${text(m.content)}`); continue; }
      if (m.role === 'assistant') {
        const parts = [];
        if (text(m.content)) parts.push(text(m.content));
        for (const call of m.tool_calls || []) { names.set(call.id, call.function?.name || 'tool'); parts.push(callBlock(call.function?.name, parseArgs(call.function?.arguments))); }
        if (parts.length) transcript.push(`Assistant:\n${parts.join('\n')}`);
        continue;
      }
      transcript.push(`Human:\n${text(m.content)}`);
    }
  } else {
    if (body.instructions) system.push(String(body.instructions));
    const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : (body.input || []);
    for (const item of input) {
      if (item.type === 'reasoning') continue;
      if (item.type === 'function_call') { names.set(item.call_id, item.name); transcript.push(`Assistant:\n${callBlock(item.name, parseArgs(item.arguments))}`); continue; }
      if (item.type === 'custom_tool_call') { names.set(item.call_id, item.name); transcript.push(`Assistant:\n${callBlock(item.name, { input: item.input ?? '' })}`); continue; }
      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') { transcript.push(`Tool result (${names.get(item.call_id) || 'tool'}):\n${text(item.output)}`); continue; }
      const role = item.role || 'user';
      if (['system', 'developer'].includes(role)) system.push(text(item.content));
      else transcript.push(`${role === 'assistant' ? 'Assistant' : 'Human'}:\n${text(item.content)}`);
    }
  }
  const specs = toolSpecs(body.tools);
  const header = [
    '# Conversation from a client application',
    'Reply to the last Human message as the Assistant, following the client instructions below. You have no tools of your own in this environment; only the client tools listed (if any) exist.',
    system.length ? `## Client instructions\n${system.join('\n\n')}` : '',
    specs.length ? toolInstructions(specs) : '',
  ].filter(Boolean).join('\n\n');
  return { prompt: `${header}\n\n# Conversation\n\n${transcript.join('\n\n') || 'Human:\nHello'}`, specs };
}

export function clampEffort(deployment, effort) {
  const max = MAX_EFFORT[deployment];
  if (!max || !EFFORT_ORDER.includes(effort)) return effort;
  return EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(max) ? max : effort;
}

export function codexArgs({ deployment, effort, workDir }) {
  return [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '-s', 'read-only', '-C', workDir, '-m', deployment,
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    '-c', `model_reasoning_effort="${clampEffort(deployment, effort)}"`,
    ...DISABLED_FEATURES.flatMap(f => ['--disable', f]),
    '-',
  ];
}

export async function runChatgptCli({ body, protocol, route, effort, sink, signal, stateDir }) {
  const exe = codexCliPath();
  if (!exe) throw new BridgeError('The Codex CLI is not installed on the bridge machine. Install the Codex app or `npm i -g @openai/codex`, then use “Log in with ChatGPT”.', 503);
  if (!/^[a-z0-9][a-z0-9.\-]{1,60}$/i.test(route.deployment)) throw new BridgeError('Invalid ChatGPT model name', 400);
  const { prompt, specs } = buildPrompt(body, protocol);
  // An empty working folder, so even a misbehaving run has nothing to read.
  const workDir = path.join(stateDir, 'chatgpt-empty');
  mkdirSync(workDir, { recursive: true });

  const child = spawn(exe, codexArgs({ deployment: route.deployment, effort, workDir }), { cwd: workDir, env: { ...process.env }, windowsHide: true });
  child.stdin.end(prompt);
  sink.open({ model: route.id, upstreamModel: route.deployment, provider: 'chatgpt', routeMode: 'chatgpt', responseId: `resp_${randomUUID().replaceAll('-', '')}` });
  const onAbort = () => { try { child.kill(); } catch {} };
  signal?.addEventListener('abort', onAbort);

  let finalText = '', errorMessage = null, blocked = null, stderrText = '';
  child.stderr.on('data', d => { if (stderrText.length < 4000) stderrText += d; });
  try {
    await new Promise((resolve, reject) => {
      let buffer = '';
      const timeout = setTimeout(() => { try { child.kill(); } catch {} reject(new BridgeError('ChatGPT (Codex CLI) timed out', 504)); }, 600000);
      const handle = line => {
        if (!line.trim()) return;
        let e; try { e = JSON.parse(line); } catch { return; }
        const item = e.item;
        if (item && !ALLOWED_ITEMS.has(item.type) && !blocked) {
          blocked = item.type;
          try { child.kill(); } catch {}
          return;
        }
        if (e.type === 'item.completed' && item?.type === 'agent_message' && item.text) finalText += (finalText ? '\n\n' : '') + item.text;
        if (e.type === 'turn.completed' && e.usage) {
          const u = e.usage;
          sink.session.usage = { inputTokens: u.input_tokens || 0, outputTokens: (u.output_tokens || 0), cachedTokens: u.cached_input_tokens || 0 };
        }
        if (e.type === 'turn.failed') errorMessage = e.error?.message || 'ChatGPT request failed';
        if (e.type === 'error' && e.message) errorMessage = e.message;
      };
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let pos;
        while ((pos = buffer.indexOf('\n')) >= 0) { try { handle(buffer.slice(0, pos)); } catch {} buffer = buffer.slice(pos + 1); }
      });
      child.on('error', error => { clearTimeout(timeout); reject(new BridgeError(`Could not start the Codex CLI: ${error.message}`, 503)); });
      child.on('exit', code => {
        clearTimeout(timeout);
        if (buffer) { try { handle(buffer); } catch {} }
        if (blocked) return reject(new BridgeError(`Blocked: the ChatGPT model tried to use a local tool (${blocked}); bridge requests may not act on this machine.`, 502));
        const problem = errorMessage || (!finalText && code !== 0 ? stderrText.trim().split('\n').pop() : null);
        if (problem) {
          const auth = /not logged in|log ?in|401|unauthori[sz]ed|sign in|auth/i.test(problem);
          return reject(new BridgeError(auth ? 'ChatGPT is not signed in on the bridge. Open the bridge app and use “Log in with ChatGPT”.' : String(problem).slice(0, 300), auth ? 503 : 502));
        }
        resolve();
      });
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const idx = finalText.indexOf(CALL_OPEN);
  if (idx >= 0) {
    const before = finalText.slice(0, idx).replace(/\s+$/, '');
    const raw = finalText.slice(idx + CALL_OPEN.length).split(CALL_CLOSE)[0].replace(/```(json)?/g, '').trim();
    let call = null;
    try { call = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { call = JSON.parse(m[0]); } catch {} } }
    if (call?.name) {
      if (before) sink.text(before);
      const callId = `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const spec = specs.find(s => s.name === call.name);
      const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
      if (spec?.freeform && sink.customTool) sink.customTool({ callId, name: String(call.name), input: typeof args.input === 'string' ? args.input : JSON.stringify(args) });
      else sink.tool({ callId, name: String(call.name), arguments: args });
      sink.completeForTool();
      return;
    }
  }
  sink.text(finalText);
  sink.complete();
}
