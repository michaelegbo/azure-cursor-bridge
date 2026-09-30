import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, clampEffort, codexArgs, promptBudget } from '../src/chatgpt-cli-adapter.mjs';

test('a conversation too long for the model keeps its newest messages and stays under the Codex limit', () => {
  const messages = [{ role: 'system', content: 'Instructions stay.' }];
  for (let i = 0; i < 400; i++) {
    messages.push({ role: 'user', content: `question ${i} ` + 'x'.repeat(3000) });
    messages.push({ role: 'assistant', content: `answer ${i} ` + 'y'.repeat(3500) });
  }
  messages.push({ role: 'user', content: 'FINAL QUESTION' });
  const full = messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(full > 2_600_000, 'about the size of the failing conversation');
  const budget = promptBudget(272000);
  const { prompt, dropped } = buildPrompt({ messages }, 'chat', budget);
  assert.ok(prompt.length <= budget, `${prompt.length} <= ${budget}`);
  assert.ok(prompt.length < 1_048_576, 'under the Codex per-turn cap');
  assert.ok(dropped > 0);
  assert.match(prompt, /Instructions stay\./);
  assert.match(prompt, /earlier messages left out by the bridge/);
  assert.ok(prompt.trimEnd().endsWith('FINAL QUESTION'), 'the newest message is always kept');
  assert.match(prompt, /answer 399 /, 'the most recent turns are kept');
  assert.doesNotMatch(prompt, /question 0 /, 'the oldest turns are dropped');
});

test('a single huge message is shortened in the middle rather than dropped', () => {
  const { prompt, dropped } = buildPrompt({ messages: [{ role: 'user', content: 'START' + 'z'.repeat(2_000_000) + 'END' }] }, 'chat', 100_000);
  assert.equal(dropped, 0);
  assert.ok(prompt.length <= 100_000);
  assert.match(prompt, /START/);
  assert.match(prompt, /END$/);
  assert.match(prompt, /characters left out by the bridge/);
});

test('short conversations are passed through untouched', () => {
  const { prompt, dropped } = buildPrompt({ messages: [{ role: 'user', content: 'hi' }] }, 'chat');
  assert.equal(dropped, 0);
  assert.doesNotMatch(prompt, /left out by the bridge/);
});

test('every Codex tool that could act on this machine is switched off', () => {
  const args = codexArgs({ deployment: 'gpt-6-astra', effort: 'high', workDir: 'C:/empty' });
  const disabled = args.flatMap((a, i) => a === '--disable' ? [args[i + 1]] : []);
  for (const f of ['shell_tool', 'unified_exec', 'view_image', 'browser_use', 'computer_use', 'apps', 'plugins', 'code_mode_host', 'multi_agent'])
    assert.ok(disabled.includes(f), `${f} must be disabled`);
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--json']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.equal(args.at(-1), '-', 'the prompt is read from stdin, never from the command line');
});

test('reasoning effort is capped where a model has no max', () => {
  assert.equal(clampEffort('gpt-5.5', 'max'), 'xhigh');
  assert.equal(clampEffort('gpt-5.5', 'high'), 'high');
  assert.equal(clampEffort('gpt-6-astra', 'max'), 'max');
});

test('a chat conversation with tool calls becomes one prompt with the tool protocol', () => {
  const { prompt, specs } = buildPrompt({
    messages: [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'What is in a.txt?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'hello' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }],
  }, 'chat');
  assert.match(prompt, /## Client instructions\nBe terse\./);
  assert.match(prompt, /Human:\nWhat is in a\.txt\?/);
  assert.match(prompt, /"name":"read_file","arguments":\{"path":"a\.txt"\}/);
  assert.match(prompt, /Tool result \(read_file\):\nhello/);
  assert.deepEqual(specs.map(s => s.name), ['read_file']);
});

test('Codex-style freeform tools and their results carry over from a responses request', () => {
  const { prompt, specs } = buildPrompt({
    instructions: 'You are Codex.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Run the tests' }] },
      { type: 'custom_tool_call', call_id: 'x1', name: 'exec', input: 'npm test' },
      { type: 'custom_tool_call_output', call_id: 'x1', output: '2 passing' },
      { type: 'reasoning', summary: [] },
    ],
    tools: [{ type: 'custom', name: 'exec', description: 'Run a command' }],
  }, 'responses');
  assert.equal(specs[0].freeform, true);
  assert.match(prompt, /"name":"exec","arguments":\{"input":"npm test"\}/);
  assert.match(prompt, /Tool result \(exec\):\n2 passing/);
  assert.match(prompt, /You are Codex\./);
});
