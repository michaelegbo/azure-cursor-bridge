import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResponsesCallIds } from '../src/azure-adapter.mjs';

test('a tool call without a call_id is dropped instead of failing the whole turn', () => {
  const input = [
    { role: 'user', content: 'fix the bug' },
    { type: 'function_call', call_id: 'call_ok', name: 'shell', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_ok', output: 'done' },
    { type: 'function_call', name: 'shell', arguments: '{}' },
    { role: 'user', content: 'continue' },
  ];
  const out = normalizeResponsesCallIds(input);
  assert.deepEqual(out.map(i => i.type || i.role), ['user', 'function_call', 'function_call_output', 'user']);
  assert.equal(out[1].call_id, 'call_ok');
});

test('an output without a call_id, or whose call is missing, is dropped too', () => {
  const input = [
    { type: 'function_call', call_id: 'call_a', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_a', output: 'a' },
    { type: 'function_call_output', output: 'no id' },
    { type: 'function_call_output', call_id: 'call_orphan', output: 'orphan' },
  ];
  const out = normalizeResponsesCallIds(input);
  assert.deepEqual(out.map(i => i.call_id), ['call_a', 'call_a']);
});

test('custom (freeform) tool items follow the same rules', () => {
  const input = [
    { type: 'custom_tool_call', call_id: 'call_p', name: 'apply_patch', input: 'x' },
    { type: 'custom_tool_call_output', call_id: 'call_p', output: 'ok' },
    { type: 'custom_tool_call', name: 'apply_patch', input: 'partial' },
  ];
  const out = normalizeResponsesCallIds(input);
  assert.equal(out.length, 2);
  assert.ok(out.every(i => i.call_id === 'call_p'));
});

test('healthy histories pass through unchanged apart from id normalization', () => {
  const long = 'call_' + 'y'.repeat(90);
  const input = [
    { role: 'user', content: 'hi' },
    { type: 'function_call', call_id: long, name: 'x', arguments: '{}' },
    { type: 'function_call_output', call_id: long, output: 'ok' },
  ];
  const out = normalizeResponsesCallIds(input);
  assert.equal(out.length, 3);
  assert.equal(out[1].call_id, out[2].call_id);
  assert.ok(out[1].call_id.length <= 64);
});
