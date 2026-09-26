import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './errors.mjs';
import { responsesToChat } from './azure-adapter.mjs';

// Bridge effort levels -> Claude Code thinking budgets (MAX_THINKING_TOKENS).
export const CLI_EFFORT_THINKING = { low: 0, medium: 4096, high: 16384, xhigh: 32768, max: 63999 };

const CALL_OPEN = '<<<TOOL_CALL>>>';
const CALL_CLOSE = '<<<END_TOOL_CALL>>>';

export function claudeCliPath() {
  return path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
}
export function claudeCliAvailable() { return existsSync(claudeCliPath()); }

const text = c => typeof c === 'string' ? c : (c || []).map(p => p.text || '').filter(Boolean).join('\n');

function toolInstructions(tools) {
  const specs = tools.map(t => ({ name: t.function?.name || t.name, description: t.function?.description || t.description || '', parameters: t.function?.parameters || t.parameters || {} }));
  return [
    '# Tool calling',
    'You can use the tools listed below. The client executes them and returns the result to you.',
    `To call a tool, end your reply with EXACTLY this block (no code fences, nothing after it):`,
    `${CALL_OPEN}`,
    `{"name":"<tool name>","arguments":{ ... }}`,
    `${CALL_CLOSE}`,
    'Rules: one tool call per reply at most. Arguments must be valid JSON matching the tool schema. If no tool is needed, answer directly in plain text without the block. Never mention this block format to the user.',
    '## Available tools (JSON Schema)',
    JSON.stringify(specs),
  ].join('\n');
}

// Runs one completion through the local Claude Code CLI on the user's Claude
// login. Client tool calling is emulated: tool schemas go into the system
// prompt with a strict call format, calls are parsed out of the stream and
// returned as OpenAI tool_calls, and tool results come back in the next
// stateless request. Claude Code's own built-in tools stay fully disabled.
export async function runClaudeCli({ body, protocol, route, effort, sink, signal, stateDir }) {
  if (!claudeCliAvailable()) throw new BridgeError('The Claude CLI is not installed on the bridge machine.', 503);
  const base = protocol === 'chat' ? body : responsesToChat(body);
  const tools = (base.tools || []).filter(t => t.function?.name || t.name);
  const systemParts = [];
  const transcript = [];
  const callNames = new Map();
  for (const m of base.messages || []) {
    if (['system', 'developer'].includes(m.role)) { systemParts.push(text(m.content)); continue; }
    if (m.role === 'tool') {
      const name = callNames.get(m.tool_call_id) || 'tool';
      transcript.push(`Tool result (${name}):\n${text(m.content)}`);
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      const t = text(m.content);
      if (t) parts.push(t);
      for (const call of m.tool_calls || []) {
        callNames.set(call.id, call.function?.name || 'tool');
        parts.push(`${CALL_OPEN}\n${JSON.stringify({ name: call.function?.name, arguments: JSON.parse(call.function?.arguments || '{}') })}\n${CALL_CLOSE}`);
      }
      if (parts.length) transcript.push(`Assistant:\n${parts.join('\n')}`);
      continue;
    }
    transcript.push(`Human:\n${text(m.content)}`);
  }
  const prompt = transcript.join('\n\n') || 'Hello';
  const system = [
    ...systemParts,
    tools.length ? toolInstructions(tools) : 'No tools are available in this environment. Always answer directly in plain text.',
  ].join('\n\n');

  const workDir = path.join(stateDir, 'sandbox');
  mkdirSync(workDir, { recursive: true });
  const systemFile = path.join(workDir, `system-${randomUUID()}.txt`);
  writeFileSync(systemFile, system);

  // --tools "" removes every Claude Code built-in tool: the model can only
  // "call" the emulated client tools above, and bridge callers can never
  // drive real tools on this machine.
  const args = ['-p', '--model', route.deployment, '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--max-turns', '1', '--strict-mcp-config', '--restricted', '--tools', '', '--system-prompt-file', systemFile];
  const cliEnv = { ...process.env, CLAUDE_CODE_DISABLE_AUTOUPDATE: '1' };
  if (route.deployment === 'claude-opus-5-5') {
    // Opus 5.5 always uses adaptive thinking; effort is its thinking control.
    args.push('--effort', effort || 'medium');
    delete cliEnv.MAX_THINKING_TOKENS;
  } else {
    cliEnv.MAX_THINKING_TOKENS = String(CLI_EFFORT_THINKING[effort] ?? 16384);
  }
  const child = spawn(claudeCliPath(), args, {
    cwd: workDir,
    env: cliEnv,
    windowsHide: true,
  });
  child.stdin.end(prompt);
  sink.open({ model: route.id, upstreamModel: route.deployment, provider: 'claude-cli', routeMode: 'claude-cli', responseId: `resp_${randomUUID().replaceAll('-', '')}` });

  const cleanup = () => { try { rmSync(systemFile, { force: true }); } catch {} };
  const onAbort = () => { try { child.kill(); } catch {} };
  signal?.addEventListener('abort', onAbort);

  // Stream text while holding back enough of the tail to detect the tool-call
  // marker before it reaches the client.
  let pending = '', toolBuf = null, emittedAny = false;
  const HOLDBACK = CALL_OPEN.length + 8;
  const emitText = chunk => { if (chunk) { emittedAny = true; sink.text(chunk); } };
  const pushDelta = delta => {
    if (toolBuf !== null) { toolBuf += delta; return; }
    pending += delta;
    const idx = pending.indexOf(CALL_OPEN);
    if (idx >= 0) {
      emitText(pending.slice(0, idx).replace(/\s+$/, ''));
      toolBuf = pending.slice(idx + CALL_OPEN.length);
      pending = '';
      return;
    }
    if (pending.length > HOLDBACK) {
      emitText(pending.slice(0, pending.length - HOLDBACK));
      pending = pending.slice(pending.length - HOLDBACK);
    }
  };
  const flushText = () => { if (toolBuf === null && pending) { emitText(pending); pending = ''; } };

  let errorMessage = null, gotResult = false, stderrText = '', fullText = '';
  child.stderr.on('data', d => { if (stderrText.length < 4000) stderrText += d; });

  try {
    await new Promise((resolve, reject) => {
      let buffer = '';
      const timeout = setTimeout(() => { try { child.kill(); } catch {} reject(new BridgeError('Claude CLI timed out', 504)); }, 600000);
      const handleLine = line => { try { handleLineUnsafe(line); } catch {} };
      const handleLineUnsafe = line => {
        if (!line.trim()) return;
        let event; try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'stream_event') {
          const delta = event.event?.delta;
          if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) { fullText += delta.text; pushDelta(delta.text); }
          return;
        }
        if (event.type === 'assistant') {
          if (event.error === 'authentication_failed' || event.is_api_error_message) {
            errorMessage = (event.message?.content || []).map(c => c.text || '').join(' ') || 'Claude CLI authentication failed';
          } else if (!fullText) {
            for (const block of event.message?.content || []) if (block.type === 'text' && block.text) { fullText += block.text; pushDelta(block.text); }
          }
          return;
        }
        if (event.type === 'result') {
          gotResult = true;
          if (event.is_error) errorMessage = errorMessage || String(event.result || 'Claude CLI request failed').slice(0, 300);
          const u = event.usage || {};
          const cached = u.cache_read_input_tokens || 0;
          sink.session.usage = { inputTokens: (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0, cachedTokens: cached };
        }
      };
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let pos;
        while ((pos = buffer.indexOf('\n')) >= 0) { handleLine(buffer.slice(0, pos)); buffer = buffer.slice(pos + 1); }
      });
      child.on('error', error => { clearTimeout(timeout); reject(new BridgeError(`Could not start the Claude CLI: ${error.message}`, 503)); });
      child.on('exit', code => {
        clearTimeout(timeout);
        if (buffer) handleLine(buffer);
        if (errorMessage && fullText && /max.?turns|Claude CLI request failed/i.test(errorMessage)) errorMessage = null;
        if (errorMessage) {
          const notLoggedIn = /not logged in|authentication/i.test(errorMessage);
          reject(new BridgeError(notLoggedIn ? 'The Claude CLI is not logged in. Open the bridge app and use “Log in with Claude”.' : errorMessage, notLoggedIn ? 503 : 502));
        } else if (code !== 0 && !gotResult && !fullText) {
          reject(new BridgeError(`Claude CLI exited with code ${code}: ${stderrText.slice(0, 200)}`, 502));
        } else resolve();
      });
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    cleanup();
  }

  if (toolBuf !== null) {
    const raw = toolBuf.split(CALL_CLOSE)[0].replace(/```(json)?/g, '').trim();
    let call = null;
    try { call = JSON.parse(raw); } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) { try { call = JSON.parse(match[0]); } catch {} }
    }
    if (call?.name) {
      sink.tool({ callId: `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`, name: String(call.name), arguments: call.arguments && typeof call.arguments === 'object' ? call.arguments : {} });
      sink.completeForTool();
      return;
    }
    // Malformed call block: deliver what we have as text instead of dropping it.
    emitText(CALL_OPEN + toolBuf);
  }
  flushText();
  if (!emittedAny && fullText) sink.text(fullText);
  sink.complete();
}
