// Manual end-to-end check (not part of `npm test`): launches the app from this
// checkout as a brand-new install with its own empty data folder and port,
// exercises the Settings page, and saves screenshots. Usage:
//   node test/e2e-fresh-install.mjs <empty-state-dir> <port> <screenshot-dir>
import { _electron } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [stateDir, portArg, shots] = process.argv.slice(2);
const port = Number(portArg);
if (!stateDir || !port || !shots) throw Error('usage: node test/e2e-fresh-install.mjs <empty-state-dir> <port> <screenshot-dir>');
if (existsSync(path.join(stateDir, 'bridge.db'))) throw Error('state dir must be empty');
mkdirSync(stateDir, { recursive: true });
mkdirSync(shots, { recursive: true });
// Pre-set only the port, so this test never touches a bridge already running on 17834.
writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port, apiKey: 'ccp_' + randomBytes(32).toString('base64url') }));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = await _electron.launch({ executablePath: electronExe, args: [repo], env: { ...process.env, CODEX_BRIDGE_STATE_DIR: stateDir } });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(ok ? 'PASS' : 'FAIL', name, detail); };
try {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const snap = () => win.evaluate(() => window.azureBridge.snapshot());
  await win.waitForSelector('#wizard:not([hidden])', { timeout: 15000 }).catch(() => {});
  check('first-run wizard offers setup on a fresh install', await win.isVisible('#wizard'));
  await win.screenshot({ path: path.join(shots, '1-wizard.png') });
  await win.click('#wiz-skip');

  let s;
  // A brand-new temporary URL can take a few minutes to resolve.
  for (let i = 0; i < 300; i++) { s = await snap(); if (s.running && !s.busy && (s.baseUrl || s.tunnel?.error)) break; await sleep(1000); }
  check('bridge starts on the configured port', s.running && s.localUrl === `http://127.0.0.1:${port}/v1`, s.localUrl);
  check('fresh install has the Claude and ChatGPT models', ['bridge-claude-opus', 'bridge-chatgpt-astra'].every(id => s.models.some(m => m.id === id)));
  check('no tunnel configured → temporary public URL', s.mode === 'quick' && /trycloudflare\.com\/v1$/.test(s.baseUrl), s.baseUrl || s.tunnel?.error);
  if (s.baseUrl) {
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) { try { ok = (await (await fetch(s.baseUrl.replace(/\/v1$/, '/health'), { signal: AbortSignal.timeout(5000) })).json()).service === 'azure-cursor-bridge'; } catch { await sleep(3000); } }
    check('temporary public URL reaches the bridge', ok);
  }
  const showPage = async page => { await win.click(`#nav button[data-page="${page}"]`); await sleep(400); };
  await showPage('overview');
  await win.screenshot({ path: path.join(shots, '2-overview.png') });

  // Subscription accounts: the panels show who is signed in, and the default
  // models answer through this fresh bridge.
  for (let i = 0; i < 20 && !(s.claudeCli?.checked && s.chatgpt?.checked); i++) { await sleep(1000); s = await snap(); }
  check('Claude panel shows the signed-in account', !s.claudeCli.loggedIn || Boolean(s.claudeCli.account?.email), s.claudeCli.account?.email || 'not signed in');
  check('ChatGPT panel shows the signed-in account and plan', !s.chatgpt.loggedIn || Boolean(s.chatgpt.account?.email && s.chatgpt.account?.plan), `${s.chatgpt.account?.email || 'not signed in'} · ${s.chatgpt.account?.plan || ''}`);
  await showPage('overview');
  check('plan switchers list the signed-in plans', (await win.locator('#claude-plan option').count()) >= 1 && (await win.locator('#chatgpt-plan option').count()) >= 1);
  await win.locator('#chatgpt-plan').scrollIntoViewIfNeeded();
  await sleep(500);
  await win.screenshot({ path: path.join(shots, '2b-accounts.png') });

  // Model cards save the reasoning mode as soon as it changes.
  await showPage('overview');
  await win.selectOption('#effort-bridge-claude-haiku', 'high');
  for (let i = 0; i < 20 && s.models.find(m => m.id === 'bridge-claude-haiku')?.defaultEffort !== 'high'; i++) { await sleep(500); s = await snap(); }
  check('changing a card’s reasoning mode saves it immediately', s.models.find(m => m.id === 'bridge-claude-haiku')?.defaultEffort === 'high');
  check('the card confirms the save', /Saved/.test(await win.textContent('#saved-bridge-claude-haiku')), await win.textContent('#saved-bridge-claude-haiku'));
  await win.locator('#effort-bridge-claude-haiku').scrollIntoViewIfNeeded();
  await win.screenshot({ path: path.join(shots, '2c-card-saved.png') });
  const ownerKey = JSON.parse(readFileSync(path.join(stateDir, 'config.json'), 'utf8')).apiKey;
  for (const model of ['bridge-claude-haiku-low', 'bridge-chatgpt-astra-low']) {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json', 'x-bridge-client': 'Verification' }, body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'Reply with exactly: fresh-install-ok' }] }), signal: AbortSignal.timeout(180000) });
    const j = await r.json().catch(() => null);
    check(`${model} answers on a fresh install`, r.status === 200 && /fresh-install-ok/.test(j?.choices?.[0]?.message?.content || ''), `${r.status} ${j?.choices?.[0]?.message?.content || j?.error?.message || ''}`.slice(0, 160));
  }

  // Bloat remover: a long conversation is trimmed before it goes upstream.
  await win.evaluate(() => window.azureBridge.appSettings({ bloatLevel: 'aggressive' }));
  const fileText = (name, n) => Array.from({ length: n }, (_, j) => `${name}:${j} const v${j} = ${j * 7};`).join('\n');
  const messages = [{ role: 'system', content: 'You are a coding assistant.' }];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: `Read file ${i}.` });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: `{"path":"f${i}.js"}` } }] });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: fileText(`f${i}`, 600) });
    messages.push({ role: 'assistant', content: `File ${i} defines 600 constants.` });
  }
  messages.push({ role: 'user', content: 'Reply with exactly: trimmed-ok' });
  const trimmedReply = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json', 'x-bridge-client': 'Verification' }, body: JSON.stringify({ model: 'bridge-claude-haiku-low', stream: false, messages }), signal: AbortSignal.timeout(180000) });
  const trimmedJson = await trimmedReply.json().catch(() => null);
  check('a long conversation still gets its answer with the bloat remover on', trimmedReply.status === 200 && /trimmed-ok/.test(trimmedJson?.choices?.[0]?.message?.content || ''), `${trimmedReply.status} ${trimmedJson?.choices?.[0]?.message?.content || trimmedJson?.error?.message || ''}`.slice(0, 120));
  s = await snap();
  const trimmedRow = s.requests.find(r => r.model === 'bridge-claude-haiku' && r.client === 'Verification');
  const detail = trimmedRow ? await win.evaluate(id => window.azureBridge.requestDetail(id), trimmedRow.id) : null;
  check('the request breakdown shows what the bloat remover removed', detail?.trim?.level === 'aggressive' && detail.trim.afterChars < detail.trim.beforeChars / 2, detail?.trim ? `${detail.trim.beforeChars} → ${detail.trim.afterChars} chars, ${detail.trim.shortened} shortened` : 'no trim stats');
  await showPage('requests');
  await sleep(800);
  await win.locator('#requests tr.req-row').first().click();
  await sleep(800);
  await win.screenshot({ path: path.join(shots, '2d-request-trimmed.png') });

  await showPage('settings');
  await sleep(1500);
  await win.screenshot({ path: path.join(shots, '3-settings.png'), fullPage: true });
  check('settings shows the database location', (await win.textContent('#data-file')).includes(stateDir));

  const off = await win.evaluate(() => window.azureBridge.tunnel({ action: 'save', mode: 'off', fallback: true }));
  s = await snap();
  check('public URL can be turned off', s.mode === 'off' && !s.baseUrl, off.message);
  const named = await win.evaluate(() => window.azureBridge.tunnel({ action: 'save', mode: 'named', hostname: 'bridge.example.com', fallback: true }).then(r => r.message, e => e.message));
  check('own tunnel without a token is refused with guidance', /enter both its public hostname and its tunnel token/.test(named), named);

  const newPort = port + 1;
  const moved = await win.evaluate(p => window.azureBridge.server({ action: 'port', port: p }), newPort);
  s = await snap();
  check('port can be changed from Settings', s.running && s.localUrl === `http://127.0.0.1:${newPort}/v1`, moved.message);

  const saved = await win.evaluate(() => window.azureBridge.appSettings({ requestHistoryLimit: 200, breakdownLimit: 20 }));
  s = await snap();
  check('history limits are configurable', s.appSettings.requestHistoryLimit === 200 && s.appSettings.breakdownLimit === 20, saved.message);

  const cleared = await win.evaluate(() => window.azureBridge.data({ action: 'clear', parts: ['requests', 'usage', 'preferences', 'models'] }));
  s = await snap();
  check('clear + reset to defaults works', s.appSettings.requestHistoryLimit === 500 && s.appSettings.tunnelMode === 'auto' && s.data.requests === 0, cleared.message);
  for (let i = 0; i < 90 && !(s.baseUrl && !s.busy); i++) { await sleep(1000); s = await snap(); }
  check('after reset the temporary public URL comes back', s.mode === 'quick' && Boolean(s.baseUrl), s.baseUrl);
  await showPage('settings');
  await sleep(1000);
  await win.screenshot({ path: path.join(shots, '4-settings-after-reset.png'), fullPage: true });
} finally {
  // The proxy and tunnel are detached (they outlive the window by design), so
  // stop this test's copies first; they also hold Playwright's pipes open.
  for (const name of ['tunnel.pid', 'proxy.pid']) {
    try { process.kill(Number(readFileSync(path.join(stateDir, name), 'utf8'))); } catch {}
  }
  await Promise.race([app.close().catch(() => {}), sleep(10000)]);
  try { app.process().kill(); } catch {}
}
const failed = results.filter(r => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
