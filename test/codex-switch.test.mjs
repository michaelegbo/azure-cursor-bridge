import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createCodexSwitch } from '../electron/codex-switch.mjs';

const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../electron');
const models = [
  { id: 'azure-astra', label: 'Azure Astra', contextWindow: 1050000, maxInputTokens: 922000, defaultEffort: 'high' },
  { id: 'bridge-claude-opus', label: 'Claude Opus', contextWindow: 1000000, defaultEffort: 'max' },
];
test('Codex switch exposes bridge models and restores prior settings without disturbing other edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-switch-'));
  try {
    const codexHome = path.join(root, 'codex');
    const stateDir = path.join(root, 'state');
    await mkdir(codexHome);
    const configPath = path.join(codexHome, 'config.toml');
    await writeFile(configPath, 'model = "gpt-6-astra"\nservice_tier = "priority"\n\n[mcp_servers.example]\ncommand = "keep-me"\n');
    const manager = createCodexSwitch({ codexHome, stateDir, assetsDir });
    assert.equal((await manager.status()).enabled, false);
    assert.deepEqual(await manager.enable(models, 17834), { enabled: true, modelCount: 2, defaultModel: 'azure-astra' });
    assert.equal((await manager.status()).enabled, true);
    const catalog = JSON.parse(await readFile(path.join(stateDir, 'codex-model-catalog.json'), 'utf8'));
    assert.deepEqual(catalog.models.map(m => m.slug), ['azure-astra', 'bridge-claude-opus']);
    assert.equal(catalog.models[1].default_reasoning_level, 'max');
    if (process.env.TEST_CODEX_CLI === '1') {
      const result = spawnSync('codex', ['debug', 'models'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /azure-astra/);
      assert.match(result.stdout, /bridge-claude-opus/);
    }
    let switched = await readFile(configPath, 'utf8');
    assert.match(switched, /model_provider = 'azure_cursor_bridge_local'/);
    assert.match(switched, /127\.0\.0\.1:17834/);
    assert.doesNotMatch(switched, /^service_tier\s*=/m);
    switched = switched.replace('command = "keep-me"', 'command = "keep-me"\nargs = ["changed"]');
    await writeFile(configPath, switched);
    await manager.disable();
    const restored = await readFile(configPath, 'utf8');
    assert.match(restored, /model = "gpt-6-astra"/);
    assert.match(restored, /service_tier = "priority"/);
    assert.match(restored, /args = \["changed"\]/);
    assert.doesNotMatch(restored, /azure_cursor_bridge_local/);
    assert.equal((await manager.status()).enabled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex switch restores prior settings even after the model was changed in Codex while bridge mode was on', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-switch-'));
  try {
    const codexHome = path.join(root, 'codex');
    const stateDir = path.join(root, 'state');
    await mkdir(codexHome);
    const configPath = path.join(codexHome, 'config.toml');
    await writeFile(configPath, 'model = "gpt-6-astra"\n');
    const manager = createCodexSwitch({ codexHome, stateDir, assetsDir });
    await manager.enable(models, 17834);
    // Codex persists model-picker choices to the config while bridge mode is on.
    const changed = (await readFile(configPath, 'utf8')).replace("model = 'azure-astra'", "model = 'bridge-claude-opus'");
    await writeFile(configPath, changed);
    const result = await manager.disable();
    assert.equal(result.enabled, false);
    const restored = await readFile(configPath, 'utf8');
    assert.match(restored, /model = "gpt-6-astra"/);
    assert.doesNotMatch(restored, /azure_cursor_bridge_local/);
    assert.equal((await manager.status()).enabled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex switch withdraws only its own block when another tool took over the provider', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-switch-'));
  try {
    const codexHome = path.join(root, 'codex');
    const stateDir = path.join(root, 'state');
    await mkdir(codexHome);
    const configPath = path.join(codexHome, 'config.toml');
    await writeFile(configPath, 'model = "gpt-6-astra"\n');
    const manager = createCodexSwitch({ codexHome, stateDir, assetsDir });
    await manager.enable(models, 17834);
    const takenOver = (await readFile(configPath, 'utf8')).replace("model_provider = 'azure_cursor_bridge_local'", "model_provider = 'lmstudio_local'");
    await writeFile(configPath, takenOver);
    const result = await manager.disable();
    assert.equal(result.enabled, false);
    assert.match(result.note, /left your settings/);
    const after = await readFile(configPath, 'utf8');
    assert.match(after, /model_provider = 'lmstudio_local'/);
    assert.doesNotMatch(after, /Codex toggle BEGIN/);
    assert.equal((await manager.status()).enabled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
