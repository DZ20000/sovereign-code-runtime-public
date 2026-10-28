import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Component {
  ecosystem: string; name: string; version: string; license: string;
  licenseFiles?: Array<{ name: string; file: string; sha256: string }>;
}
const inventory = JSON.parse(readFileSync("licenses/dependency-inventory.json", "utf8")) as {
  components: Component[];
  sourceInputs: string[];
  sourceInputSha256: Record<string, string>;
  summary: { npm: number; cargo: number; android: number; localTexts: number; licenseTextGaps: number; missingLicenseDeclaration: string[] };
  npmCoverage: { lockPackageRecords: number; listedPackageVersions: number; unlistedLockResolutions: string[] };
};
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("source dependency license evidence", () => {
  it("binds inventory evidence to the checked-in dependency inputs", () => {
    for (const file of inventory.sourceInputs) {
      expect(hash(readFileSync(file)), file).toBe(inventory.sourceInputSha256[file]);
    }
  });

  it("reports actual component counts and does not conceal missing text evidence", () => {
    const values = inventory.components;
    expect(new Set(values.map(c => [c.ecosystem, c.name, c.version].join(":"))).size).toBe(values.length);
    expect(values.filter(c => c.ecosystem === "npm")).toHaveLength(inventory.summary.npm);
    expect(values.filter(c => c.ecosystem === "cargo")).toHaveLength(inventory.summary.cargo);
    expect(values.filter(c => c.ecosystem === "maven")).toHaveLength(inventory.summary.android);
    expect(values.every(c => typeof c.license === "string" && c.license.length > 0)).toBe(true);
    expect(inventory.summary.missingLicenseDeclaration).toEqual([]);
    const textGaps = values.filter(c => ["npm", "cargo"].includes(c.ecosystem) && !(c.licenseFiles?.length));
    expect(textGaps).toHaveLength(inventory.summary.licenseTextGaps);
    expect(readdirSync("licenses/third-party").filter(file => file.endsWith(".txt"))).toHaveLength(inventory.summary.localTexts);
  });

  it("retains the exact bytes of every referenced upstream notice", () => {
    for (const component of inventory.components) for (const file of component.licenseFiles ?? []) {
      expect(file.file).toMatch(/^licenses\/third-party\/[a-f0-9]{64}\.txt$/);
      expect(hash(readFileSync(file.file)), component.name + " " + file.name).toBe(file.sha256);
    }
  });

  it("explicitly accounts for every optional lock resolution outside the platform inventory", () => {
    const text = readFileSync("pnpm-lock.yaml", "utf8");
    const start = text.indexOf("\npackages:\n"), end = text.indexOf("\nsnapshots:\n");
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    const locked = [...text.slice(start, end).matchAll(/^  (\S.*):$/gm)].map(match => match[1]!.replace(/^'|'$/g, ""));
    const covered = inventory.components.filter(c => c.ecosystem === "npm").map(c => c.name + "@" + c.version);
    const absent = inventory.npmCoverage.unlistedLockResolutions;
    expect(new Set([...covered, ...absent]).size).toBe(covered.length + absent.length);
    expect([...covered, ...absent].sort()).toEqual(locked.sort());
    expect(locked).toHaveLength(inventory.npmCoverage.lockPackageRecords);
    expect(covered).toHaveLength(inventory.npmCoverage.listedPackageVersions);
  });
});
