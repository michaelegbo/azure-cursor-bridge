import { safeStorage } from 'electron';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Secrets are encrypted with the OS keystore via Electron safeStorage:
// DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux.
export function createSecrets(stateDir) {
  const encPath = name => path.join(stateDir, `${name}.enc`);

  async function set(name, value) {
    const buf = safeStorage.encryptString(String(value));
    await writeFile(encPath(name), buf.toString('base64'));
  }
  async function get(name) {
    try {
      const b64 = (await readFile(encPath(name), 'utf8')).trim();
      return safeStorage.decryptString(Buffer.from(b64, 'base64'));
    } catch { return null; }
  }
  const has = name => existsSync(encPath(name));

  // Legacy migration: earlier Windows-only versions stored secrets as
  // PowerShell SecureString DPAPI blobs. Decrypt each once and re-encrypt
  // with safeStorage. Only runs on Windows and only for missing secrets.
  function dpapiDecrypt(file) {
    return new Promise((resolve, reject) => {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', "$s=(Get-Content -LiteralPath $env:AZ_FILE -Raw).Trim() | ConvertTo-SecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}"], { env: { ...process.env, AZ_FILE: file }, windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', d => out += d);
      child.stderr.on('data', d => err += d);
      child.on('error', reject);
      child.on('exit', c => c === 0 ? resolve(out.trim()) : reject(Error(err.slice(0, 200) || 'DPAPI decrypt failed')));
    });
  }

  async function migrateLegacy() {
    if (process.platform !== 'win32') return;
    const pairs = [
      ['azure-key', path.join(stateDir, 'azure-key.dpapi')],
      ['tunnel-token', path.join(stateDir, 'tunnel-token.dpapi')],
    ];
    const versionsDir = path.join(stateDir, 'azure-key-versions');
    if (existsSync(versionsDir)) {
      for (const name of await readdir(versionsDir).catch(() => [])) {
        const m = /^v(\d+)\.dpapi$/.exec(name);
        if (m) pairs.push([`azure-key-v${m[1]}`, path.join(versionsDir, name)]);
      }
    }
    for (const [name, file] of pairs) {
      if (has(name) || !existsSync(file)) continue;
      try { await set(name, await dpapiDecrypt(file)); } catch {}
    }
  }

  return { set, get, has, migrateLegacy };
}
