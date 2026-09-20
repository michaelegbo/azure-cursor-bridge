import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './errors.mjs';
import { responsesToChat } from './azure-adapter.mjs';

// Bridge effort levels -> Claude Code thinking budgets (MAX_THINKING_TOKENS).
export const CLI_EFFORT_THINKING = { low: 0, medium: 4096, high: 16384, xhigh: 32768, max: 63999 };

export function claudeCliPath() {
  return path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
}
export function claudeCliAvailable() { return existsSync(claudeCliPath()); }

const text = c => typeof c === 'string' ? c : (c || []).map(p => p.text || '').filter(Boolean).join('\n');

// Runs one plain-text completion through the local Claude Code CLI using the
// user's Claude login. Client-defined tools are not forwarded: the CLI cannot
// accept arbitrary tool schemas, so these models are chat/ask models.
export async function runClaudeCli({ body, protocol, route, effort, sink, signal, stateDir }) {
  if (!claudeCliAvailable()) throw new BridgeError('The Claude CLI is not installed on the bridge machine.', 503);
  const base = protocol === 'chat' ? body : responsesToChat(body);
  const systemParts = [];
  const transcript = [];
  for (const m of base.messages || []) {
    if (['system', 'developer'].includes(m.role)) { systemParts.push(text(m.content)); continue; }
    if (m.role === 'tool') { transcript.push(`Tool result:\n${text(m.content)}`); continue; }
    if (m.role === 'assistant') { const t = text(m.content); if (t) transcript.push(`Assistant:\n${t}`); continue; }
    transcript.push(`Human:\n${text(m.content)}`);
  }
  const prompt = transcript.join('\n\n') || 'Hello';
  const system = [...systemParts, 'Tools are not available in this environment. Always answer directly in plain text.'].join('\n\n');

  const workDir = path.join(stateDir, 'sandbox');
  mkdirSync(workDir, { recursive: true });
  const systemFile = path.join(workDir, `system-${randomUUID()}.txt`);
  writeFileSync(systemFile, system);

  const args = ['-p', '--model', route.deployment, '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--max-turns', '1', '--strict-mcp-config', '--system-prompt-file', systemFile];
  const child = spawn(claudeCliPath(), args, {
    cwd: workDir,
    env: { ...process.env, MAX_THINKING_TOKENS: String(CLI_EFFORT_THINKING[effort] ?? 16384), CLAUDE_CODE_DISABLE_AUTOUPDATE: '1' },
    windowsHide: true,
  });
  child.stdin.end(prompt);
  sink.open({ model: route.id, upstreamModel: route.deployment, provider: 'claude-cli', routeMode: 'claude-cli', responseId: `resp_${randomUUID().replaceAll('-', '')}` });

  const cleanup = () => { try { rmSync(systemFile, { force: true }); } catch {} };
  const onAbort = () => { try { child.kill(); } catch {} };
  signal?.addEventListener('abort', onAbort);

  let sawDelta = false, finalText = '', errorMessage = null, gotResult = false, stderrText = '';
  child.stderr.on('data', d => { if (stderrText.length < 4000) stderrText += d; });

  try {
    await new Promise((resolve, reject) => {
      let buffer = '';
      const timeout = setTimeout(() => { try { child.kill(); } catch {} reject(new BridgeError('Claude CLI timed out', 504)); }, 600000);
      const handleLine = line => {
        try { handleLineUnsafe(line); } catch {}
      };
      const handleLineUnsafe = line => {
        if (!line.trim()) return;
        let event; try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'stream_event') {
          const delta = event.event?.delta;
          if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) { sawDelta = true; sink.text(delta.text); }
          return;
        }
        if (event.type === 'assistant') {
          if (event.error === 'authentication_failed' || event.is_api_error_message) {
            errorMessage = (event.message?.content || []).map(c => c.text || '').join(' ') || 'Claude CLI authentication failed';
          } else if (!sawDelta) {
            for (const block of event.message?.content || []) if (block.type === 'text' && block.text) { finalText += block.text; }
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
        if (errorMessage) {
          const notLoggedIn = /not logged in|authentication/i.test(errorMessage);
          reject(new BridgeError(notLoggedIn ? 'The Claude CLI is not logged in. Open the bridge app and use “Log in with Claude”.' : errorMessage, notLoggedIn ? 503 : 502));
        } else if (code !== 0 && !gotResult) {
          reject(new BridgeError(`Claude CLI exited with code ${code}: ${stderrText.slice(0, 200)}`, 502));
        } else resolve();
      });
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    cleanup();
  }
  if (!sawDelta && finalText) sink.text(finalText);
  sink.complete();
}
