import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const nativeRoot = fileURLToPath(new URL("../src-tauri/", import.meta.url));
interface Capability {
  readonly windows?: readonly string[];
  readonly permissions: readonly (string | { readonly identifier: string })[];
}
const read = (path: string) => readFileSync(join(nativeRoot, path), "utf8");

describe("native approval permission boundary", () => {
  it("declares every popup command in the generated ACL manifest and native handler", () => {
    const declaration = /AppManifest::new\(\)\.commands\(&\[([\s\S]*?)\]\)/u.exec(read("build.rs"));
    expect(declaration).not.toBeNull();
    const commands = [...declaration![1]!.matchAll(/"([a-z_]+)"/gu)].map(match => match[1]);
    const handlerBlock = /generate_handler!\[([\s\S]*?)\]/u.exec(read("src/lib.rs"));
    expect(handlerBlock).not.toBeNull();
    const handlers = handlerBlock![1]!.split(",").map(value => value.trim().split("::").at(-1));
    for (const command of ["approval_current", "approval_resolve", "approval_dismiss"]) {
      expect(commands).toContain(command);
      expect(handlers).toContain(command);
    }
  });

  it("grants approval read, decision and dismiss only to the dedicated popup", () => {
    const directory = join(nativeRoot, "capabilities");
    for (const name of readdirSync(directory).filter(name => name.endsWith(".json"))) {
      const capability = JSON.parse(readFileSync(join(directory, name), "utf8")) as Capability;
      const permissions = capability.permissions.map(permission => typeof permission === "string" ? permission : permission.identifier);
      const approvalPermissions = permissions.filter(permission => permission.startsWith("allow-approval-"));
      if (name === "approval.json") {
        expect(capability.windows).toEqual(["approval"]);
        expect(approvalPermissions.sort()).toEqual(["allow-approval-current", "allow-approval-dismiss", "allow-approval-resolve"]);
      } else {
        expect(approvalPermissions, name).toEqual([]);
      }
    }
  });
});
