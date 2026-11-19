import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMacArchive, signAdHoc, signMacApp, verifyMacApp } from "./package-macos.mjs";

const guide = fileURLToPath(new URL("../distribution/First launch.txt", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "transcript-signing-test-"));
  const app = join(root, "Transcript Studio.app");
  const contents = join(app, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources", "engine"), { recursive: true });
  writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>se.transcriptstudio.desktop</string>
<key>CFBundleName</key><string>Transcript Studio</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleExecutable</key><string>transcript-studio</string>
<key>CFBundleShortVersionString</key><string>0.2.1</string>
</dict></plist>`);
  const source = join(root, "main.c");
  const main = join(contents, "MacOS", "transcript-studio");
  writeFileSync(source, '#include <stdio.h>\nint main(void) { puts("SIGNATURE_ORIGINAL"); return 0; }\n');
  execFileSync("/usr/bin/clang", [source, "-o", main], {
    stdio: "pipe", env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(root, "clang-cache") },
  });
  const helper = join(contents, "Resources", "engine", "uv");
  cpSync(main, helper);
  writeFileSync(join(contents, "Resources", "version.txt"), "before");
  return { root, app, main, helper };
}

test("repairs a modified helper and seals the entire app through ZIP extraction", { skip: process.platform !== "darwin" }, () => {
  const f = fixture();
  try {
    signAdHoc(f.helper, "se.transcriptstudio.desktop.uv");
    const bytes = readFileSync(f.helper);
    const offset = bytes.indexOf("SIGNATURE_ORIGINAL");
    assert.notEqual(offset, -1);
    bytes.write("SIGNATURE_TAMPERED", offset);
    writeFileSync(f.helper, bytes);
    assert.notEqual(spawnSync("/usr/bin/codesign", ["--verify", "--strict", f.helper]).status, 0);
    signMacApp(f.app);
    verifyMacApp(f.app);
    assert.match(execFileSync(f.helper, { encoding: "utf8" }), /SIGNATURE_TAMPERED/);
    const archive = createMacArchive(f.app, join(f.root, "shared.zip"), guide);
    const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
    assert.ok(readFileSync(archive + ".sha256", "utf8").startsWith(checksum + "  "));
    const extracted = join(f.root, "recipient");
    execFileSync("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
    const received = join(extracted, "Transcript Studio", "Transcript Studio.app");
    verifyMacApp(received);
    assert.equal(execFileSync(join(received, "Contents", "MacOS", "transcript-studio"), { encoding: "utf8" }).trim(), "SIGNATURE_ORIGINAL");
    const instructions = readFileSync(join(extracted, "Transcript Studio", "Read Me - First launch.txt"), "utf8");
    assert.ok(instructions.includes('xattr -dr com.apple.quarantine "/Applications/Transcript Studio.app"'));
    assert.ok(!instructions.includes("--master-disable"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects changed resources without replacing the existing distributable", { skip: process.platform !== "darwin" }, () => {
  const f = fixture();
  try {
    signMacApp(f.app);
    const archive = join(f.root, "shared.zip");
    writeFileSync(archive, "previous verified artifact");
    writeFileSync(join(f.app, "Contents", "Resources", "version.txt"), "modified after signing");
    assert.throws(() => verifyMacApp(f.app));
    assert.throws(() => createMacArchive(f.app, archive, guide));
    assert.equal(readFileSync(archive, "utf8"), "previous verified artifact");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
