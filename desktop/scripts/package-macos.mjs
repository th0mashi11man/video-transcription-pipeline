import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const codesign = "/usr/bin/codesign";
const ditto = "/usr/bin/ditto";

export function verifyMacApp(app) {
  const helper = join(app, "Contents", "Resources", "engine", "uv");
  execFileSync(codesign, ["--verify", "--strict", "--all-architectures", helper], { stdio: "pipe" });
  execFileSync(codesign, ["--verify", "--deep", "--strict", "--all-architectures", app], { stdio: "pipe" });
}

export function signAdHoc(path, identifier) {
  execFileSync(codesign, [
    "--force", "--sign", "-", "--timestamp=none", "--options=0",
    "--identifier", identifier, path,
  ], { stdio: "pipe" });
  execFileSync(codesign, ["--verify", "--strict", "--all-architectures", path], { stdio: "pipe" });
}

export function signMacApp(app) {
  const helper = join(app, "Contents", "Resources", "engine", "uv");
  if (!existsSync(helper)) throw new Error("The packaged engine downloader is missing.");
  // Sign inside out. Resources and the thinned helper must already be final.
  signAdHoc(helper, "se.transcriptstudio.desktop.uv");
  signAdHoc(app, "se.transcriptstudio.desktop");
  verifyMacApp(app);
}

export function createMacArchive(app, archive, guide) {
  app = resolve(app);
  archive = resolve(archive);
  verifyMacApp(app);
  mkdirSync(dirname(archive), { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), "transcript-studio-package-"));
  try {
    const contents = join(temporary, "Transcript Studio");
    mkdirSync(contents);
    const copy = join(contents, basename(app));
    cpSync(app, copy, { recursive: true, preserveTimestamps: true });
    cpSync(guide, join(contents, "Read Me - First launch.txt"));
    verifyMacApp(copy);
    // Build and validate a new archive before replacing the shared artifact.
    const stagedArchive = join(temporary, "distribution.zip");
    execFileSync(ditto, ["-c", "-k", "--sequesterRsrc", "--keepParent", contents, stagedArchive], { stdio: "pipe" });
    const extracted = join(temporary, "extracted");
    execFileSync(ditto, ["-x", "-k", stagedArchive, extracted], { stdio: "pipe" });
    verifyMacApp(join(extracted, "Transcript Studio", basename(app)));
    cpSync(stagedArchive, archive);
    const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(archive + ".sha256", `${hash}  ${basename(archive)}\n`);
    return archive;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
