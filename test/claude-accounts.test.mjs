import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAccountDir, activeClaudeConfigDir } from '../src/claude-cli-adapter.mjs';
import { chatgptAccountDir, activeCodexHome } from '../src/chatgpt-cli-adapter.mjs';

const fakeDb = active => ({ settingGet: key => (key === 'claude-account-active' ? active : null) });

test('the default account uses the normal Claude login; saved accounts get their own folder', () => {
  assert.equal(claudeAccountDir('S', 'default'), null);
  assert.equal(claudeAccountDir('S', ''), null);
  assert.equal(claudeAccountDir('S', 'personal'), path.join('S', 'claude-accounts', 'personal'));
});

test('account ids can never point outside the accounts folder', () => {
  for (const id of ['..', '../x', 'a/b', 'a\\b', 'C:', 'Personal', '-x', 'x'.repeat(41)]) assert.equal(claudeAccountDir('S', id), null, id);
});

test('ChatGPT accounts work the same way, each with its own CODEX_HOME', () => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'chatgpt-accounts-'));
  const db = { settingGet: key => (key === 'chatgpt-account-active' ? 'work' : null) };
  try {
    assert.equal(chatgptAccountDir('S', 'default'), null);
    assert.equal(chatgptAccountDir('S', '../x'), null);
    assert.equal(chatgptAccountDir('S', 'work'), path.join('S', 'chatgpt-accounts', 'work'));
    assert.equal(activeCodexHome(db, state), null, 'missing folder falls back to the default login');
    mkdirSync(path.join(state, 'chatgpt-accounts', 'work'), { recursive: true });
    assert.equal(activeCodexHome(db, state), path.join(state, 'chatgpt-accounts', 'work'));
    assert.equal(activeCodexHome(fakeDb('work'), state), null, 'the Claude selection does not affect ChatGPT');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('the proxy runs Claude models on the selected account, falling back to the default login', () => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-'));
  try {
    assert.equal(activeClaudeConfigDir(fakeDb(null), state), null);
    assert.equal(activeClaudeConfigDir(fakeDb('personal'), state), null, 'missing folder falls back to default');
    mkdirSync(path.join(state, 'claude-accounts', 'personal'), { recursive: true });
    assert.equal(activeClaudeConfigDir(fakeDb('personal'), state), path.join(state, 'claude-accounts', 'personal'));
    assert.equal(activeClaudeConfigDir({ settingGet() { throw Error('db locked'); } }, state), null);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
