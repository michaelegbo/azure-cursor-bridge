import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAccountDir, activeClaudeConfigDir } from '../src/claude-cli-adapter.mjs';

const fakeDb = active => ({ settingGet: key => (key === 'claude-account-active' ? active : null) });

test('the default account uses the normal Claude login; saved accounts get their own folder', () => {
  assert.equal(claudeAccountDir('S', 'default'), null);
  assert.equal(claudeAccountDir('S', ''), null);
  assert.equal(claudeAccountDir('S', 'personal'), path.join('S', 'claude-accounts', 'personal'));
});

test('account ids can never point outside the accounts folder', () => {
  for (const id of ['..', '../x', 'a/b', 'a\\b', 'C:', 'Personal', '-x', 'x'.repeat(41)]) assert.equal(claudeAccountDir('S', id), null, id);
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
