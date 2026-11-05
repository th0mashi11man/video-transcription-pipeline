import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const privateDir = join(desktop, "src-tauri", ".private");
const tokenFile = join(privateDir, "huggingface-token");
const buildArguments = process.argv.slice(2);
const reuseRuntime = buildArguments.includes("--reuse-runtime");

try {
  // Refuse to generate a credential file if Git would pick it up.
  execFileSync("git", ["check-ignore", "--quiet", "--", tokenFile], {
    cwd: desktop,
    stdio: "pipe",
  });
} catch {
  console.error(
    "Private packaging is blocked: the credential directory must be ignored by Git.",
  );
  process.exit(1);
}

let token = process.env.TRANSCRIPT_STUDIO_HF_TOKEN?.trim();
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
      "No saved speaker credential was found. Add a token in the app, then package again.",
    );
    process.exit(1);
  }
}
if (!token || !/^hf_[A-Za-z0-9]{10,}$/.test(token)) {
  console.error(
    "Private packaging requires the saved credential or TRANSCRIPT_STUDIO_HF_TOKEN.",
  );
  process.exit(1);
}

mkdirSync(privateDir, { recursive: true, mode: 0o700 });
// The shared app must not depend on Python installed on the sender's Mac.
// uv's standalone interpreter is relocatable; installed wheels travel with it.
const projectPython = join(
  desktop,
  "..",
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
if (!existsSync(projectPython)) {
  console.error(
    "Install the project environment with uv sync --extra speakers first.",
  );
  process.exit(1);
}
let runtimeInfo;
try {
  runtimeInfo = JSON.parse(
    execFileSync(
      projectPython,
      [
        "-c",
        'import json,sys,site; import imageio_ffmpeg; print(json.dumps({"base":sys.base_prefix,"site":site.getsitepackages()[0],"version":f"python{sys.version_info.major}.{sys.version_info.minor}"}))',
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
} catch {
  console.error(
    "The Python environment is incomplete. Run uv sync --python 3.12 --extra speakers.",
  );
  process.exit(1);
}
console.log(
  "Including the local Python engine and audio decoder for a self-contained private build.",
);
const runtime = join(privateDir, "runtime");
const targetSite =
  process.platform === "win32"
    ? join(runtime, "Lib", "site-packages")
    : join(runtime, "lib", runtimeInfo.version, "site-packages");
if (!(reuseRuntime && existsSync(join(targetSite, "imageio_ffmpeg")))) {
  cpSync(runtimeInfo.base, runtime, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  cpSync(runtimeInfo.site, targetSite, { recursive: true, dereference: true });
}
writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
token = undefined;
const buildEnv = { ...process.env };
delete buildEnv.TRANSCRIPT_STUDIO_HF_TOKEN;
console.log(
  "Packaging a private app with included speaker access. Credential content is never printed.",
);
let status = 1;
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
      "src-tauri/tauri.private.conf.json",
      ...buildArguments.filter((arg) => arg !== "--reuse-runtime"),
    ],
    { cwd: desktop, env: buildEnv, stdio: "inherit" },
  );
  status = result.status ?? 1;
} finally {
  // The completed app contains the resource; the source checkout does not.
  unlinkSync(tokenFile);
}
process.exitCode = status;
