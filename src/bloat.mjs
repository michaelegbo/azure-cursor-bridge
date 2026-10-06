import { createHash } from 'node:crypto';

// Bloat remover (Settings → Bloat remover). Clients resend the whole
// conversation every turn, and most of its weight is old tool output: file
// dumps, logs, repeated reads. Each level trims more of what is OLDER than the
// last few turns; the system prompt, tool definitions and the newest turns are
// never touched, and no message is ever dropped (so tool calls and their
// results stay paired) — except at 'deep', where whole early turns are replaced
// by an AI-written summary at a user-message boundary.
export const BLOAT_LEVELS = ['off', 'small', 'medium', 'high', 'aggressive', 'deep'];

// keepTurns: turns (counted in user messages from the end) left untouched.
// cleanFrom: tool output older than this many turns is tidied (colour codes,
// blank-line runs, repeated lines, duplicates). Infinity = never.
const PROFILES = {
  small: { cleanFrom: 2, keepTurns: Infinity },
  medium: { cleanFrom: 2, keepTurns: 6, toolMax: 8000 },
  high: { cleanFrom: 2, keepTurns: 4, toolMax: 2000, assistantMax: 4000, patchMax: 4000, dropImages: true },
  aggressive: { cleanFrom: 2, keepTurns: 3, toolMax: 400, assistantMax: 1500, userMax: 4000, patchMax: 1500, dropImages: true },
  deep: { cleanFrom: 2, keepTurns: 3, toolMax: 400, assistantMax: 1500, userMax: 4000, patchMax: 1500, dropImages: true, summarize: true },
};
// Deep summarizes in blocks of this many turns, so the summary (and the
// upstream prompt cache behind it) only changes once per block.
const SUMMARY_BLOCK_TURNS = 6;
const MIN_SUMMARY_CHARS = 20000;
const MAX_SUMMARY_INPUT = 300000;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function cleanText(s) {
  const t = s.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');
  const lines = t.split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(lines[i]);
    if (j - i > 3 && lines[i].trim()) out.push(`[previous line repeated ${j - i - 1} more times]`);
    else for (let k = i + 1; k < j; k++) out.push(lines[k]);
    i = j;
  }
  return out.join('\n');
}
export function shortenText(s, max) {
  if (s.length <= max) return s;
  const note = `\n…[${(s.length - max).toLocaleString('en-US')} characters removed by the bridge's bloat remover]…\n`;
  const head = Math.max(0, Math.floor(max * 0.6));
  return s.slice(0, head) + note + s.slice(s.length - Math.max(0, max - head));
}

const isUser = (m, protocol) => (protocol === 'chat' ? m.role === 'user' : (m.role === 'user' && (!m.type || m.type === 'message')));
const isSystem = m => ['system', 'developer'].includes(m.role);

// Every trimmable piece of text, with what kind it is and how old.
function collectSlots(items, protocol) {
  const slots = [];
  let usersAfter = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    const turnsAgo = usersAfter;
    if (isUser(m, protocol)) usersAfter++;
    if (!m || typeof m !== 'object' || isSystem(m)) continue;
    const addContent = (holder, field, kind) => {
      const v = holder[field];
      if (typeof v === 'string') slots.push({ kind, turnsAgo, get: () => holder[field], set: x => { holder[field] = x; } });
      else if (Array.isArray(v)) for (let p = 0; p < v.length; p++) {
        const part = v[p];
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string') slots.push({ kind, turnsAgo, get: () => part.text, set: x => { part.text = x; } });
        else if (['image_url', 'input_image'].includes(part.type)) slots.push({ kind: 'image', turnsAgo, replace: () => { v[p] = { type: protocol === 'chat' ? 'text' : 'input_text', text: '[image removed by the bridge\'s bloat remover]' }; } });
      }
    };
    if (protocol === 'chat') {
      if (m.role === 'tool') addContent(m, 'content', 'tool');
      else if (m.role === 'assistant') addContent(m, 'content', 'assistant');
      else addContent(m, 'content', 'user');
    } else if (m.type === 'function_call_output' || m.type === 'custom_tool_call_output') addContent(m, 'output', 'tool');
    else if (m.type === 'custom_tool_call') addContent(m, 'input', 'patch');
    else if (!m.type || m.type === 'message') addContent(m, 'content', m.role === 'assistant' ? 'assistant' : 'user');
  }
  return slots.reverse();
}

const charsOf = items => JSON.stringify(items).length;

// Plain-text transcript of a span, for the summarizer.
function transcript(items, protocol) {
  const text = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p?.text || '').filter(Boolean).join('\n') : '');
  return items.map(m => {
    if (protocol === 'chat') {
      if (m.role === 'tool') return `Tool result:\n${text(m.content)}`;
      if (m.role === 'assistant') return `Assistant:\n${[text(m.content), ...(m.tool_calls || []).map(c => `[called ${c.function?.name}(${String(c.function?.arguments || '').slice(0, 500)})]`)].filter(Boolean).join('\n')}`;
      return `User:\n${text(m.content)}`;
    }
    if (m.type === 'function_call') return `[called ${m.name}(${String(m.arguments || '').slice(0, 500)})]`;
    if (m.type === 'custom_tool_call') return `[called ${m.name}: ${String(m.input || '').slice(0, 500)}]`;
    if (m.type === 'function_call_output' || m.type === 'custom_tool_call_output') return `Tool result:\n${text(m.output)}`;
    if (m.type && m.type !== 'message') return '';
    return `${m.role === 'assistant' ? 'Assistant' : 'User'}:\n${text(m.content)}`;
  }).filter(Boolean).join('\n\n');
}
export const SUMMARY_PROMPT = 'Below is the earlier part of a conversation between a user and an AI coding assistant. Summarize it so the assistant can continue the work without it. Keep: the user\'s goals and requirements, decisions made, files and code locations involved, commands run and their important results, errors and how they were resolved, and anything still open. Drop: verbose tool output, repeated content and pleasantries. Write concise bullet points, at most 1,500 words.\n\n';

/**
 * Trim a chat-completions or responses request body. Returns a new body (the
 * original is not modified) and stats for the request breakdown.
 * summarize(text) → Promise<string> is only used at 'deep'; cache has
 * get(key)/set(key, text) for summaries.
 */
export async function trimBloat(body, protocol, level, { summarize = null, cache = null } = {}) {
  const profile = PROFILES[level];
  const field = protocol === 'chat' ? 'messages' : 'input';
  if (!profile || !Array.isArray(body?.[field])) return { body, stats: null };
  const out = structuredClone(body);
  let items = out[field];
  const stats = { level, beforeChars: charsOf(items), afterChars: 0, cleaned: 0, deduped: 0, shortened: 0, imagesRemoved: 0, summarizedTurns: 0 };

  const seen = new Map();
  for (const slot of collectSlots(items, protocol)) {
    if (slot.kind === 'image') {
      if (profile.dropImages && slot.turnsAgo >= profile.keepTurns) { slot.replace(); stats.imagesRemoved++; }
      continue;
    }
    let text = slot.get();
    if (slot.kind === 'tool' && slot.turnsAgo >= profile.cleanFrom) {
      const cleaned = cleanText(text);
      if (cleaned !== text) { text = cleaned; stats.cleaned++; }
      if (text.length >= 1000) {
        const hash = createHash('sha1').update(text).digest('hex');
        if (seen.has(hash)) { text = `[identical to an earlier tool result (${text.length.toLocaleString('en-US')} characters) — removed by the bridge's bloat remover]`; stats.deduped++; }
        else seen.set(hash, true);
      }
    }
    if (slot.turnsAgo >= profile.keepTurns) {
      const max = { tool: profile.toolMax, assistant: profile.assistantMax, user: profile.userMax, patch: profile.patchMax }[slot.kind];
      if (max && text.length > max) { text = shortenText(text, max); stats.shortened++; }
    }
    if (text !== slot.get()) slot.set(text);
  }

  if (profile.summarize && summarize) {
    try {
      const lead = items.findIndex(m => !isSystem(m));
      const users = items.map((m, i) => (i >= lead && isUser(m, protocol) ? i : -1)).filter(i => i >= 0);
      const turns = Math.floor((users.length - profile.keepTurns) / SUMMARY_BLOCK_TURNS) * SUMMARY_BLOCK_TURNS;
      if (lead >= 0 && turns >= SUMMARY_BLOCK_TURNS) {
        const cut = users[turns];
        const span = items.slice(lead, cut);
        const spanText = transcript(span, protocol);
        if (spanText.length >= MIN_SUMMARY_CHARS) {
          const key = createHash('sha256').update(`${protocol}\n${spanText}`).digest('hex');
          let summary = cache?.get(key) || null;
          stats.summaryCached = Boolean(summary);
          if (!summary) {
            summary = String(await summarize(SUMMARY_PROMPT + shortenText(spanText, MAX_SUMMARY_INPUT)) || '').trim();
            if (summary) cache?.set(key, summary);
          }
          if (summary) {
            const note = `[Summary of the earlier conversation (${turns} turns), written by the bridge's bloat remover to save context]\n\n${summary}`;
            items = [...items.slice(0, lead), { role: 'user', content: note }, { role: 'assistant', content: 'Understood — I will continue from this summary.' }, ...items.slice(cut)];
            out[field] = items;
            stats.summarizedTurns = turns;
          }
        }
      }
    } catch (error) {
      stats.summaryError = String(error?.message || error).slice(0, 200);
    }
  }

  stats.afterChars = charsOf(items);
  return { body: out, stats };
}
