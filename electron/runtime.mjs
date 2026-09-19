import { spawn } from 'node:child_process';
import { openSync, closeSync, existsSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Cross-platform lifecycle manager. The proxy server runs on Electron's own
// bundled Node (ELECTRON_RUN_AS_NODE), so no separate Node installation is
// needed. cloudflared is bundled per platform under bridge/vendor.
export function createRuntime({ stateDir, bridgeRoot, secrets, log }) {
  const serverPath = path.join(bridgeRoot, 'src', 'server.mjs');
  const cloudflaredPath = () => {
    const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    for (const p of [path.join(bridgeRoot, 'vendor', name), path.join(bridgeRoot, 'vendor', process.platform, name)]) {
      if (existsSync(p)) return p;
    }
    throw Error('cloudflared is not bundled for this platform');
  };
  const statePath = name => path.join(stateDir, name);

  async function readJson(name) {
    try { return JSON.parse((await readFile(statePath(name), 'utf8')).replace(/^﻿/, '')); } catch { return null; }
  }
  async function pidAlive(name) {
    try {
      const pid = Number((await readFile(statePath(name), 'utf8')).trim());
      if (!pid) return null;
      process.kill(pid, 0);
      return pid;
    } catch { return null; }
  }
  async function killPid(name) {
    const pid = await pidAlive(name);
    if (pid) { try { process.kill(pid); } catch {} }
    await rm(statePath(name), { force: true }).catch(() => {});
  }
  async function health(port) {
    try {
      const r = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).json();
      return r?.service === 'azure-cursor-bridge';
    } catch { return false; }
  }
  async function publicHealth(url) {
    try {
      const r = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })).json();
      return r?.service === 'azure-cursor-bridge';
    } catch { return false; }
  }
  function spawnLogged(file, args, extraEnv, outName, errName) {
    const out = openSync(statePath(outName), 'w');
    const err = openSync(statePath(errName), 'w');
    const child = spawn(file, args, {
      cwd: bridgeRoot,
      env: { ...process.env, ...extraEnv },
      // detached on every platform: otherwise the OS ties the child to the
      // app process and kills the proxy/tunnel when the app window is closed.
      // The bridge must keep serving Cursor/Codex with the app closed.
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
    });
    child.unref();
    closeSync(out); closeSync(err);
    return child;
  }

  async function startProxy() {
    const config = await readJson('config.json');
    const port = config?.port || 17834;
    if (await health(port)) return port;
    const azureKey = (await secrets.get('azure-key')) || '';
    const child = spawnLogged(process.execPath, [serverPath], {
      ELECTRON_RUN_AS_NODE: '1',
      CODEX_BRIDGE_STATE_DIR: stateDir,
      AZURE_BRIDGE_KEY: azureKey,
    }, 'proxy.log', 'proxy-error.log');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await delay(300);
      if (await health(port)) return port;
      if (child.exitCode !== null && child.exitCode !== 0) break;
    }
    throw Error(`The proxy did not become healthy. See ${statePath('proxy-error.log')}`);
  }

  async function stopProxy() {
    await killPid('proxy.pid');
    const config = await readJson('config.json');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && await health(config?.port || 17834)) await delay(200);
  }

  async function startTunnel() {
    const config = await readJson('config.json');
    const existing = await readJson('tunnel.json');
    if (existing?.publicUrl && await pidAlive('tunnel.pid') && await publicHealth(existing.publicUrl)) return existing;
    await killPid('tunnel.pid');
    await rm(statePath('tunnel.json'), { force: true }).catch(() => {});

    const named = await readJson('named-tunnel.json');
    const token = named ? await secrets.get('tunnel-token') : null;
    let child, publicUrl;
    if (named && token) {
      child = spawnLogged(cloudflaredPath(), ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run'], { TUNNEL_TOKEN: token }, 'tunnel.log', 'tunnel-error.log');
      publicUrl = `https://${named.hostname}`;
    } else {
      child = spawnLogged(cloudflaredPath(), ['tunnel', '--url', `http://127.0.0.1:${config?.port || 17834}`, '--protocol', 'http2', '--no-autoupdate'], {}, 'tunnel.log', 'tunnel-error.log');
      const deadline = Date.now() + 45000;
      while (!publicUrl && Date.now() < deadline) {
        await delay(500);
        for (const logName of ['tunnel.log', 'tunnel-error.log']) {
          const text = await readFile(statePath(logName), 'utf8').catch(() => '');
          const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
          if (match) { publicUrl = match[0]; break; }
        }
        if (child.exitCode !== null) break;
      }
      if (!publicUrl) { try { child.kill(); } catch {} throw Error(`The tunnel did not publish a URL. See ${statePath('tunnel-error.log')}`); }
    }
    await writeFile(statePath('tunnel.pid'), String(child.pid));

    if (named && token) {
      // Permanent hostname: DNS already exists, so reachability is a hard gate.
      const deadline = Date.now() + 60000;
      let healthy = false;
      while (Date.now() < deadline) {
        if (await publicHealth(publicUrl)) { healthy = true; break; }
        if (child.exitCode !== null) break;
        await delay(1500);
      }
      if (!healthy) { try { child.kill(); } catch {} await rm(statePath('tunnel.pid'), { force: true }).catch(() => {}); throw Error(`The tunnel URL did not become reachable. See ${statePath('tunnel-error.log')}`); }
    } else {
      // Quick tunnel: cloudflared logging a registered connection is the real
      // success signal. The fresh hostname can take minutes to reach local
      // resolvers, so DNS/reachability below is best-effort, not a gate.
      const regDeadline = Date.now() + 45000;
      let registered = false;
      while (Date.now() < regDeadline) {
        const text = (await readFile(statePath('tunnel.log'), 'utf8').catch(() => '')) + (await readFile(statePath('tunnel-error.log'), 'utf8').catch(() => ''));
        if (/Registered tunnel connection/.test(text)) { registered = true; break; }
        if (child.exitCode !== null) break;
        await delay(500);
      }
      if (!registered) { try { child.kill(); } catch {} await rm(statePath('tunnel.pid'), { force: true }).catch(() => {}); throw Error(`The tunnel did not connect to Cloudflare. See ${statePath('tunnel-error.log')}`); }
      const host = new URL(publicUrl).hostname;
      const dnsDeadline = Date.now() + 120000;
      while (Date.now() < dnsDeadline) {
        try {
          const doh = await (await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) })).json();
          if (doh?.Answer?.length) break;
        } catch {}
        await delay(1500);
      }
      if (process.platform === 'win32') { try { spawn('ipconfig', ['/flushdns'], { windowsHide: true }).unref(); } catch {} }
      const warmDeadline = Date.now() + 45000;
      while (Date.now() < warmDeadline) {
        if (await publicHealth(publicUrl)) break;
        await delay(1500);
      }
    }

    const state = { pid: child.pid, publicUrl, baseUrl: `${publicUrl}/v1`, startedAt: new Date().toISOString(), ...(named ? { mode: 'named', tunnelName: named.tunnelName } : {}) };
    await writeFile(statePath('tunnel.json'), JSON.stringify(state, null, 2));
    return state;
  }

  async function stopTunnel() { await killPid('tunnel.pid'); await rm(statePath('tunnel.json'), { force: true }).catch(() => {}); }

  async function start() {
    await startProxy();
    const status = { at: new Date().toISOString(), proxy: { ok: true }, tunnel: { ok: false, error: null } };
    try {
      const tunnel = await startTunnel();
      status.tunnel = { ok: true, error: null, baseUrl: tunnel.baseUrl, publicUrl: tunnel.publicUrl };
    } catch (error) {
      status.tunnel.error = error.message;
      log?.(`tunnel failed: ${error.message}`);
    }
    await writeFile(statePath('start-status.json'), JSON.stringify(status, null, 2));
    return status;
  }

  async function stop() { await stopTunnel(); await stopProxy(); }

  async function restartProxy() { await stopProxy(); await startProxy(); }

  return { start, stop, startProxy, stopProxy, restartProxy, startTunnel, stopTunnel, health, readJson };
}
