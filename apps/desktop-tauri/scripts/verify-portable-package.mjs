import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPortablePackage } from "./release-metadata.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = resolve(projectRoot, "artifacts");
const requestedRoot = process.argv[2];
const portableRoot = requestedRoot === undefined
  ? (await readFile(resolve(artifactsRoot, "latest-portable.txt"), "utf8")).trim()
  : resolve(requestedRoot);

if (portableRoot.length === 0) {
  throw new Error("No portable package path was provided or recorded.");
}

const verification = await verifyPortablePackage(portableRoot);
console.log(JSON.stringify(verification, null, 2));
if (!verification.passed) {
  process.exitCode = 1;
}
