import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMacArchive, signAdHoc, signMacApp } from "./package-macos.mjs";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const privateDir = join(desktop, "src-tauri", ".private");
const tokenFile = join(privateDir, "huggingface-token");
const args = process.argv.slice(2);
const publicBuild = args.includes("--public");
try {
  execFileSync("git", ["check-ignore", "--quiet", "--", tokenFile], {
    cwd: desktop,
    stdio: "pipe",
  });
} catch {
  console.error("Private build files must be ignored by Git.");
  process.exit(1);
}
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
let token;
if (!publicBuild) {
  token = process.env.TRANSCRIPT_STUDIO_HF_TOKEN?.trim();
  if (!token && process.platform === "darwin") {
    try {
      token = execFileSync(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-s",
          "se.transcriptstudio.desktop",
          "-a",
          "hugging-face",
          "-w",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    } catch {
      console.error(
        "Save a speaker credential in the Mac's Keychain before making a private build.",
      );
      process.exit(1);
    }
  }
  if (!token || !/^hf_[A-Za-z0-9]{10,}$/.test(token)) {
    console.error(
      "A saved speaker credential is required for a private build.",
    );
    process.exit(1);
  }
}
let uv = process.env.UV_BIN;
if (!uv) {
  try {
    uv = execFileSync("/usr/bin/which", ["uv"], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {}
}
if (!uv || !existsSync(uv)) {
  console.error("Install uv to package the first-use engine downloader.");
  process.exit(1);
}
const bootstrap = join(
  privateDir,
  process.platform === "win32" ? "uv.exe" : "uv",
);
let thinned = false;
if (process.platform === "darwin") {
  try {
    execFileSync(
      "/usr/bin/lipo",
      [
        uv,
        "-thin",
        process.arch === "arm64" ? "arm64" : "x86_64",
        "-output",
        bootstrap,
      ],
      { stdio: "pipe" },
    );
    thinned = true;
  } catch {}
}
if (!thinned) cpSync(uv, bootstrap);
chmodSync(bootstrap, 0o755);
if (process.platform === "darwin") {
  // lipo changes signed bytes. Repair the helper before Tauri copies it.
  signAdHoc(bootstrap, "se.transcriptstudio.desktop.uv");
}
const manifest = join(desktop, "src-tauri", "engine-requirements.txt");
if (!existsSync(manifest)) {
  console.error("The engine manifest is missing.");
  process.exit(1);
}
if (!publicBuild) writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
token = undefined;
const buildEnv = { ...process.env };
delete buildEnv.TRANSCRIPT_STUDIO_HF_TOKEN;
if (process.platform === "darwin") {
  // These sharing builds never use a Developer ID or Apple's notarization service.
  for (const key of [
    "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_ID", "APPLE_PASSWORD",
    "APPLE_TEAM_ID", "APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH",
    "APPLE_PROVIDER_SHORT_NAME",
  ]) delete buildEnv[key];
  buildEnv.APPLE_SIGNING_IDENTITY = "-";
}
console.log(
  "Packaging the app without the transcription engine or model weights. Both install locally on first use.",
);
try {
  const result = spawnSync(
    join(
      desktop,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tauri.cmd" : "tauri",
    ),
    [
      "build",
      "--config",
      publicBuild
        ? "src-tauri/tauri.portable.conf.json"
        : "src-tauri/tauri.private.conf.json",
      ...args.filter((a) => !["--public", "--reuse-runtime"].includes(a)),
    ],
    { cwd: desktop, env: buildEnv, stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
  if (process.exitCode === 0 && process.platform === "darwin") {
    const option = (name) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
    };
    const profile = option("--profile") || (args.includes("--debug") ? "debug" : "release");
    const target = option("--target");
    const targetRoot = process.env.CARGO_TARGET_DIR
      ? resolve(desktop, process.env.CARGO_TARGET_DIR)
      : join(desktop, "src-tauri", "target");
    const app = join(targetRoot, ...(target ? [target] : []), profile, "bundle", "macos", "Transcript Studio.app");
    signMacApp(app);
    const architecture = execFileSync("/usr/bin/lipo", ["-archs", join(app, "Contents", "MacOS", "transcript-studio")], { encoding: "utf8" }).trim().replace(/\s+/g, "-");
    const archive = join(desktop, "..", "output", `Transcript Studio${publicBuild ? "" : "-private"}-${architecture}${profile === "release" ? "" : "-" + profile}.zip`);
    createMacArchive(app, archive, join(desktop, "distribution", "First launch.txt"));
    console.log(`Verified local signatures and extracted archive: ${archive}`);
    console.log("Includes the one-time opening guide. No Developer ID or notarization was used.");
  }
} finally {
  if (existsSync(tokenFile)) unlinkSync(tokenFile);
}
