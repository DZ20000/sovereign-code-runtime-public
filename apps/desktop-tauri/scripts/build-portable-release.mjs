import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readGitSource } from "./release-metadata.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "../..");

export function releaseRustFlags(root, cargoHome, profile) {
  // Encoded arguments preserve spaces and literal backslashes on Windows.
  const flags = [];
  for (const [from, to] of [[profile, "/home"], [cargoHome, "/cargo"], [root, "/source"]]) {
    for (const path of new Set([from, from.replaceAll("\\", "/")])) {
      flags.push("--remap-path-prefix=" + path + "=" + to);
    }
  }
  return flags.join("\x1f");
}

async function buildRelease() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Release builds require Windows x64.");
  if ((await readGitSource(workspaceRoot)).dirty) throw new Error("Commit the public release source before building.");
  const environment = {
    ...process.env,
    SCR_REQUIRE_CLEAN_PACKAGE: "1",
    NoDefaultCurrentDirectoryInExePath: "1",
    CARGO_TARGET_DIR: resolve(projectRoot, "src-tauri/target"),
    CARGO_ENCODED_RUSTFLAGS: releaseRustFlags(workspaceRoot, process.env.CARGO_HOME || resolve(homedir(), ".cargo"), homedir()),
  };
  delete environment.RUSTFLAGS;
  const command = resolve(process.env.SystemRoot ?? "C:/Windows", "System32/cmd.exe");
  for (const script of ["package:portable", "smoke:portable", "smoke:guardian:packaged", "package:portable-zip"]) {
    await new Promise((done, fail) => {
      // The command is assembled only from the fixed internal script list.
      const child = spawn(command, ["/d", "/s", "/c", "pnpm --filter @sovereign/desktop-tauri run " + script], {
        cwd: workspaceRoot, env: environment, stdio: "inherit", windowsHide: true,
      });
      child.once("error", fail);
      child.once("exit", (code) => code === 0 ? done() : fail(new Error(script + " failed (exit " + code + ").")));
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildRelease();
