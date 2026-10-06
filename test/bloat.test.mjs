import test from 'node:test';
import assert from 'node:assert/strict';
import { trimBloat, cleanText, BLOAT_LEVELS } from '../src/bloat.mjs';

// Realistic, non-repeating file contents of about `chars` characters.
const fileText = (name, chars) => Array.from({ length: Math.ceil(chars / 32) }, (_, j) => `${name}:${j} const v${j} = ${j * 7};`).join('\n');

// A Cursor-style chat: system prompt, then N turns of user → tool call →
// big tool result → assistant reply.
function chatConversation(turns, toolChars = 20000) {
  const messages = [{ role: 'system', content: 'SYSTEM PROMPT ' + 's'.repeat(5000) }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `question ${i}` });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: `{"path":"f${i}.js"}` } }] });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: fileText(`f${i}`, toolChars) });
    messages.push({ role: 'assistant', content: `answer ${i} ` + 'a'.repeat(6000) });
  }
  return { model: 'm', messages };
}

test('tidying removes colour codes, trailing spaces and repeated log lines', () => {
  assert.equal(cleanText('\x1b[31merror\x1b[0m   \nok'), 'error\nok');
  const out = cleanText('start\n' + 'Downloading...\n'.repeat(50) + 'done');
  assert.match(out, /Downloading\.\.\.\n\[previous line repeated 49 more times\]\ndone/);
});

test('every level keeps the system prompt, the newest turns and every message', async () => {
  for (const level of BLOAT_LEVELS.filter(l => l !== 'off')) {
    const body = chatConversation(12);
    const { body: out, stats } = await trimBloat(body, 'chat', level);
    assert.equal(out.messages.length, body.messages.length, `${level}: no message dropped`);
    assert.equal(out.messages[0].content, body.messages[0].content, `${level}: system prompt untouched`);
    assert.deepEqual(out.messages.slice(-8), body.messages.slice(-8), `${level}: the last two turns are untouched`);
    out.messages.forEach((m, i) => assert.equal(m.tool_call_id, body.messages[i].tool_call_id, `${level}: tool results stay paired`));
    assert.ok(stats.afterChars <= stats.beforeChars, level);
  }
});

test('higher levels remove more, and the original request is never modified', async () => {
  const body = chatConversation(12);
  const snapshot = JSON.stringify(body);
  const sizes = {};
  for (const level of ['small', 'medium', 'high', 'aggressive']) sizes[level] = (await trimBloat(body, 'chat', level)).stats.afterChars;
  assert.ok(sizes.medium < sizes.small && sizes.high < sizes.medium && sizes.aggressive < sizes.high, JSON.stringify(sizes));
  assert.ok(sizes.aggressive < JSON.stringify(body.messages).length * 0.4, 'aggressive removes most of the old tool output');
  assert.equal(JSON.stringify(body), snapshot);
});

test('identical tool results are kept once', async () => {
  const body = chatConversation(4);
  for (const i of [2, 6, 10]) body.messages[i + 1].content = fileText('same', 3000);
  const { body: out, stats } = await trimBloat(body, 'chat', 'small');
  assert.equal(stats.deduped, 1, 'the duplicate in an older turn is replaced; the current turn is left alone');
  assert.match(out.messages[7].content, /identical to an earlier tool result/);
});

test('old images are removed from high upwards, recent ones kept', async () => {
  const body = chatConversation(6, 100);
  body.messages[1].content = [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(50000) } }];
  body.messages[21].content = [{ type: 'text', text: 'and this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }];
  const { body: out, stats } = await trimBloat(body, 'chat', 'high');
  assert.equal(stats.imagesRemoved, 1);
  assert.match(out.messages[1].content[1].text, /image removed/);
  assert.equal(out.messages[21].content[1].type, 'image_url');
  assert.equal((await trimBloat(body, 'chat', 'medium')).stats.imagesRemoved, 0);
});

test('responses requests (Codex) are trimmed the same way, including old patches', async () => {
  const input = [{ role: 'developer', content: 'DEV' }];
  for (let i = 0; i < 8; i++) {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `task ${i}` }] });
    input.push({ type: 'custom_tool_call', call_id: `p${i}`, name: 'apply_patch', input: '*** Begin Patch\n' + fileText(`+patch${i}`, 12000) });
    input.push({ type: 'custom_tool_call_output', call_id: `p${i}`, output: 'Success. ' + fileText(`out${i}`, 9000) });
    input.push({ type: 'function_call', call_id: `f${i}`, name: 'shell', arguments: '{"cmd":"ls"}' });
    input.push({ type: 'function_call_output', call_id: `f${i}`, output: fileText(`ls${i}`, 15000) });
  }
  const { body: out, stats } = await trimBloat({ input }, 'responses', 'aggressive');
  assert.equal(out.input.length, input.length);
  assert.ok(stats.shortened > 0 && stats.afterChars < stats.beforeChars / 2, JSON.stringify(stats));
  assert.match(out.input[2].input, /removed by the bridge/, 'old patch shortened');
  assert.deepEqual(out.input.slice(-15), input.slice(-15), 'last three turns untouched');
  assert.deepEqual(out.input.map(m => m.call_id), input.map(m => m.call_id), 'call ids unchanged');
});

test('deep replaces whole early turns with a cached summary at a user-message boundary', async () => {
  const body = chatConversation(16, 4000);
  const store = new Map();
  const cache = { get: k => store.get(k), set: (k, v) => store.set(k, v) };
  let calls = 0;
  const summarize = async text => { calls++; assert.match(text, /Summarize it so the assistant can continue/); return 'SUMMARY OF EARLY WORK'; };
  const first = await trimBloat(body, 'chat', 'deep', { summarize, cache });
  assert.equal(first.stats.summarizedTurns, 12, 'whole blocks of 6 turns are summarized');
  const msgs = first.body.messages;
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[1].content, /SUMMARY OF EARLY WORK/);
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[3].content, 'question 12', 'the conversation resumes at a user message');
  assert.equal(msgs.length, 1 + 2 + 4 * 4);
  const again = await trimBloat(body, 'chat', 'deep', { summarize, cache });
  assert.equal(calls, 1, 'the second request reuses the cached summary');
  assert.equal(again.stats.summaryCached, true);
});

test('deep falls back to aggressive trimming if the summary fails', async () => {
  const body = chatConversation(16, 4000);
  const { body: out, stats } = await trimBloat(body, 'chat', 'deep', { summarize: async () => { throw Error('model unavailable'); } });
  assert.equal(stats.summarizedTurns, 0);
  assert.match(stats.summaryError, /model unavailable/);
  assert.equal(out.messages.length, body.messages.length);
});

test('off and unknown levels pass the request through', async () => {
  const body = chatConversation(3);
  assert.equal((await trimBloat(body, 'chat', 'off')).body, body);
  assert.equal((await trimBloat(body, 'chat', 'nonsense')).body, body);
});
