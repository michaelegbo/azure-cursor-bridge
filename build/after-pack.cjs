const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const source = path.join(context.packager.projectDir, "electron", "package.json");
  // macOS keeps resources inside the .app bundle; Windows and Linux next to the executable.
  const mac = context.electronPlatformName === "darwin" || context.electronPlatformName === "mas";
  const resources = mac
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const destination = path.join(resources, "app", "package.json");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
};
