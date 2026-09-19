// Downloads the cloudflared binary for the current platform into vendor/<platform>/.
// Run before electron-builder (npm run vendor). Skips if already present.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const platform = process.env.CLOUDFLARED_PLATFORM || process.platform;
const arch = process.env.CLOUDFLARED_ARCH || process.arch;
const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  const dir = path.join(__dirname, "..", "vendor", platform);
  fs.mkdirSync(dir, { recursive: true });

  if (platform === "win32") {
    const dest = path.join(dir, "cloudflared.exe");
    if (fs.existsSync(dest)) return console.log("cloudflared.exe already vendored");
    await download(`${base}/cloudflared-windows-amd64.exe`, dest);
    console.log("downloaded", dest);
    return;
  }

  const dest = path.join(dir, "cloudflared");
  if (fs.existsSync(dest)) return console.log("cloudflared already vendored");

  if (platform === "darwin") {
    const asset = arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
    const tgz = path.join(dir, "cloudflared.tgz");
    await download(`${base}/${asset}`, tgz);
    execFileSync("tar", ["-xzf", tgz, "-C", dir]);
    fs.rmSync(tgz);
  } else {
    const asset = arch === "arm64" ? "cloudflared-linux-arm64" : "cloudflared-linux-amd64";
    await download(`${base}/${asset}`, dest);
  }
  fs.chmodSync(dest, 0o755);
  console.log("downloaded", dest);
}

main().catch(error => { console.error(error.message); process.exit(1); });
