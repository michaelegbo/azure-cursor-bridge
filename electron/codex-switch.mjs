import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const OWNER = 'azure_cursor_bridge_local';
const BEGIN = '# Azure Cursor Bridge Codex toggle BEGIN';
const END = '# Azure Cursor Bridge Codex toggle END';
const KEYS = ['model', 'model_provider', 'model_catalog_json', 'service_tier'];
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const quoted = value => `'${String(value).replaceAll("'", "''")}'`;
const line = (key, value) => `${key} = ${value}`;

function splitConfig(content) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const firstTable = lines.findIndex(value => /^\s*\[/.test(value));
  const index = firstTable < 0 ? lines.length : firstTable;
  return { newline, head: lines.slice(0, index), tail: lines.slice(index) };
}
function getTop(head, key) {
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const found = head.filter(value => re.test(value));
  if (found.length > 1) throw Error(`Codex config has duplicate ${key} settings. Resolve those before switching.`);
  return found[0] ?? null;
}
function setTop(head, key, value) {
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const i = head.findIndex(item => re.test(item));
  if (i < 0 && value !== null) head.push(value);
  else if (i >= 0 && value === null) head.splice(i, 1);
  else if (i >= 0) head[i] = value;
}
async function atomicWrite(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, value, { mode: 0o600 });
  await rename(temp, target);
}
function removeOwnedBlock(content) {
  const start = content.indexOf(BEGIN);
  if (start < 0) throw Error('The managed Codex provider block is missing. No settings were changed.');
  const end = content.indexOf(END, start);
  if (end < 0) throw Error('The managed Codex provider block is incomplete. No settings were changed.');
  return content.slice(0, start).trimEnd() + content.slice(end + END.length);
}
function templateFor(model, template, priority) {
  return {
    ...template,
    slug: model.id,
    display_name: model.label || model.id,
    description: `${model.label || model.id} through the local Azure Cursor Bridge.`,
    priority,
    default_reasoning_level: LEVELS.includes(model.defaultEffort) ? model.defaultEffort : 'medium',
    supported_reasoning_levels: template.supported_reasoning_levels.filter(level => LEVELS.includes(level.effort)),
    context_window: model.contextWindow || 200000,
    max_context_window: model.contextWindow || 200000,
    effective_context_window_percent: model.maxInputTokens ? Math.min(100, Math.floor(model.maxInputTokens * 100 / model.contextWindow)) : 95,
    comp_hash: `azure-bridge-${model.id}`,
  };
}

export function createCodexSwitch({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), stateDir, assetsDir, configName = 'config.toml' }) {
  const configPath = path.join(codexHome, configName);
  const statePath = path.join(stateDir, 'codex-switch.json');
  const catalogPath = path.join(stateDir, 'codex-model-catalog.json');
  const keyPath = path.join(assetsDir, 'codex-key.ps1');
  const readState = async () => JSON.parse(await readFile(statePath, 'utf8').catch(() => 'null'));
  async function status() {
    const content = await readFile(configPath, 'utf8');
    const saved = await readState();
    const provider = getTop(splitConfig(content).head, 'model_provider');
    return { enabled: Boolean(saved && provider === line('model_provider', quoted(OWNER)) && content.includes(BEGIN)), managed: Boolean(saved) };
  }
  async function enable(models, port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('The local bridge port is invalid.');
    if (!Array.isArray(models) || !models.length) throw Error('The bridge has no models to expose to Codex.');
    const priorState = await readState();
    if (priorState) throw Error('Codex switch is already managed. Turn it off before enabling it again.');
    let content = await readFile(configPath, 'utf8');
    // An orphaned marker block with no saved state means a previous toggle was
    // interrupted or its state file was lost. The block is bridge-owned, so
    // reclaim it instead of refusing to switch.
    if (content.includes(BEGIN)) content = removeOwnedBlock(content);
    const { newline, head, tail } = splitConfig(content);
    const previous = Object.fromEntries(KEYS.map(key => [key, getTop(head, key)]));
    const template = JSON.parse(await readFile(path.join(assetsDir, 'codex-model-template.json'), 'utf8').then(s => s.replace(/^\uFEFF/, '')));
    const catalog = { models: models.map((model, i) => templateFor(model, template, i + 1)) };
    const chosen = models.find(model => model.id === 'azure-astra') || models[0];
    const applied = {
      model: line('model', quoted(chosen.id)),
      model_provider: line('model_provider', quoted(OWNER)),
      model_catalog_json: line('model_catalog_json', quoted(catalogPath)),
      service_tier: null,
    };
    for (const key of KEYS) setTop(head, key, applied[key]);
    const owned = [BEGIN, `[model_providers.${OWNER}]`, 'name = "Azure Cursor Bridge (local)"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', '', `[model_providers.${OWNER}.auth]`, 'command = "powershell.exe"', `args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ${quoted(keyPath)}]`, END].join(newline);
    const next = [...head, ...tail].join(newline).trimEnd() + newline + newline + owned + newline;
    await atomicWrite(catalogPath, JSON.stringify(catalog, null, 2));
    await atomicWrite(statePath, JSON.stringify({ previous, applied, configPath }, null, 2));
    try { await atomicWrite(configPath, next); }
    catch (error) { await writeFile(statePath, 'null'); throw error; }
    return { enabled: true, modelCount: models.length, defaultModel: chosen.id };
  }
  async function disable() {
    const saved = await readState();
    if (!saved) throw Error('The bridge has no previous Codex settings to restore.');
    if (saved.configPath !== configPath) throw Error('Codex home changed; refusing to restore settings in another directory.');
    const content = await readFile(configPath, 'utf8');
    const { newline, head } = splitConfig(content);
    // Codex persists model-picker choices (and may re-add service_tier) to the
    // config while bridge mode is on - that is normal use, and turning the
    // bridge off simply restores the saved settings over it. Only a changed
    // provider or catalog means another tool took over management; then leave
    // every setting alone and just withdraw the bridge's own block and state.
    const takenOver = ['model_provider', 'model_catalog_json'].some(key => getTop(head, key) !== saved.applied[key]);
    if (takenOver) {
      if (content.includes(BEGIN)) await atomicWrite(configPath, removeOwnedBlock(content).trimEnd() + newline);
      await atomicWrite(statePath, 'null');
      return { enabled: false, note: 'Another tool had changed the Codex provider, so the bridge only removed its own block and left your settings as they are.' };
    }
    const withoutBlock = removeOwnedBlock(content);
    const parts = splitConfig(withoutBlock);
    for (const key of KEYS) setTop(parts.head, key, saved.previous[key]);
    await atomicWrite(configPath, [...parts.head, ...parts.tail].join(newline).trimEnd() + newline);
    await atomicWrite(statePath, 'null');
    return { enabled: false };
  }
  return { status, enable, disable };
}
