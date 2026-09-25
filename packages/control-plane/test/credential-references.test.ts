import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CREDENTIAL_REFERENCE_SCHEMA_VERSION,
  CredentialReferenceStore,
} from "../src/credential-references.js";

const cleanupPaths: string[] = [];

function protectReference(value: string): Promise<string> {
  return Promise.resolve(
    `test-protected:${Buffer.from(value, "utf8").toString("base64url")}`,
  );
}

function restoreReference(
  encoded: string,
): Promise<{ readonly value: string; readonly encoded: string } | null> {
  if (!encoded.startsWith("test-protected:")) {
    return Promise.resolve(null);
  }
  return Promise.resolve({
    value: Buffer.from(
      encoded.slice("test-protected:".length),
      "base64url",
    ).toString("utf8"),
    encoded,
  });
}

async function fixture(): Promise<{
  readonly root: string;
  readonly path: string;
  readonly store: CredentialReferenceStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "scr-credential-refs-"));
  cleanupPaths.push(root);
  const path = join(root, "security", "credential-refs.json");
  return {
    root,
    path,
    store: new CredentialReferenceStore(path, {
      storageRoot: root,
      protectReference,
      restoreReference,
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
    ),
  );
});

describe("credential reference store", () => {
  it("persists provider references while exposing metadata only", async () => {
    const { root, path, store } = await fixture();

    const github = await store.register({
      id: "github-primary",
      label: "Primary GitHub account",
      service: "github",
      source: { kind: "github-cli" },
    });
    const openai = await store.register({
      id: "openai-build",
      label: "OpenAI build key",
      service: "openai",
      source: {
        kind: "onepassword",
        reference: "op://Engineering/OpenAI-API-Key/credential",
      },
    });
    const aws = await store.register({
      id: "anthropic-ci",
      label: "Anthropic CI key",
      service: "anthropic",
      source: {
        kind: "aws-secrets-manager",
        reference:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:anthropic/ci-AbCd12",
      },
    });

    expect(github).toMatchObject({
      id: "github-primary",
      sourceKind: "github-cli",
      sourceDisplay: "GitHub CLI host token",
    });
    expect(openai).toMatchObject({
      id: "openai-build",
      sourceKind: "onepassword",
      sourceDisplay: "1Password reference",
    });
    expect(aws.sourceDisplay).toBe("AWS Secrets Manager reference");

    const status = await store.status();
    expect(status.count).toBe(3);
    expect(status.entries.map((entry) => entry.id)).toEqual([
      "anthropic-ci",
      "github-primary",
      "openai-build",
    ]);
    const publicJson = JSON.stringify(status);
    expect(publicJson).not.toContain("op://");
    expect(publicJson).not.toContain("arn:aws:secretsmanager");
    expect(publicJson).not.toContain("OpenAI-API-Key");
    expect(publicJson).not.toContain("anthropic/ci-AbCd12");

    const persisted = await readFile(path, "utf8");
    const document = JSON.parse(persisted) as {
      schemaVersion: string;
      entries: Array<{
        id: string;
        source: { protectedReference?: string };
      }>;
    };
    expect(document.schemaVersion).toBe(CREDENTIAL_REFERENCE_SCHEMA_VERSION);
    expect(
      document.entries.find((entry) => entry.id === "openai-build")?.source
        .protectedReference,
    ).toMatch(/^test-protected:/u);
    expect(persisted).not.toContain("op://");
    expect(persisted).not.toContain("arn:aws:secretsmanager");
    expect(persisted).not.toContain("OpenAI-API-Key");
    expect(persisted).not.toContain("anthropic/ci-AbCd12");
    expect(await readdir(join(root, "security"))).toEqual([
      "credential-refs.json",
    ]);

    const restored = new CredentialReferenceStore(path, {
      storageRoot: root,
      protectReference,
      restoreReference,
    });
    await expect(restored.status()).resolves.toEqual(status);
    await expect(restored.resolve("openai-build")).resolves.toMatchObject({
      id: "openai-build",
      source: {
        kind: "onepassword",
        reference: "op://Engineering/OpenAI-API-Key/credential",
      },
    });
  });

  it("updates in place, preserves createdAt, and removes metadata only", async () => {
    const { store } = await fixture();
    const original = await store.register({
      id: "github-primary",
      label: "Original",
      service: "github",
      source: { kind: "github-cli" },
    });
    const updated = await store.register({
      id: "github-primary",
      label: "Updated",
      service: "github",
      source: { kind: "github-cli" },
    });

    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.updatedAt >= original.updatedAt).toBe(true);
    expect(updated.label).toBe("Updated");
    await expect(store.remove("github-primary")).resolves.toEqual({
      removed: true,
      id: "github-primary",
    });
    await expect(store.remove("github-primary")).resolves.toEqual({
      removed: false,
      id: "github-primary",
    });
    await expect(store.resolve("github-primary")).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    });
  });

  it("fails closed without protected storage and rewraps restored references", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-credential-protection-"));
    cleanupPaths.push(root);
    const path = join(root, "security", "credential-refs.json");
    const unprotected = new CredentialReferenceStore(path, {
      storageRoot: root,
    });
    await expect(
      unprotected.register({
        id: "openai-build",
        label: "OpenAI build key",
        service: "openai",
        source: {
          kind: "onepassword",
          reference: "op://Engineering/OpenAI-API-Key/credential",
        },
      }),
    ).rejects.toMatchObject({ code: "PROCESS_FAILED" });

    const plaintextProtector = new CredentialReferenceStore(path, {
      storageRoot: root,
      protectReference: async (value) => value,
      restoreReference,
    });
    await expect(
      plaintextProtector.register({
        id: "unsafe-openai",
        label: "Unsafe protector",
        service: "openai",
        source: {
          kind: "onepassword",
          reference: "op://Engineering/OpenAI-API-Key/credential",
        },
      }),
    ).rejects.toMatchObject({ code: "PROCESS_FAILED" });

    const rewrapping = new CredentialReferenceStore(path, {
      storageRoot: root,
      protectReference: async (value) =>
        `old:${Buffer.from(value, "utf8").toString("base64url")}`,
      restoreReference: async (encoded) => ({
        value: Buffer.from(encoded.slice("old:".length), "base64url").toString(
          "utf8",
        ),
        encoded: `new:${encoded.slice("old:".length)}`,
      }),
    });
    await rewrapping.register({
      id: "openai-build",
      label: "OpenAI build key",
      service: "openai",
      source: {
        kind: "onepassword",
        reference: "op://Engineering/OpenAI-API-Key/credential",
      },
    });
    const before = await readFile(path, "utf8");
    expect(before).toContain("old:");
    expect(before).not.toContain("op://");

    await expect(rewrapping.resolve("openai-build")).resolves.toMatchObject({
      source: {
        kind: "onepassword",
        reference: "op://Engineering/OpenAI-API-Key/credential",
      },
    });
    const after = await readFile(path, "utf8");
    expect(after).toContain("new:");
    expect(after).not.toContain("old:");
    expect(after).not.toContain("op://");
  });

  it("rejects malformed, mismatched, and duplicate registry data", async () => {
    const { path, store } = await fixture();

    await expect(
      store.register({
        id: "openai-via-gh",
        label: "Wrong provider",
        service: "openai",
        source: { kind: "github-cli" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      store.register({
        id: "bad-op",
        label: "Bad 1Password path",
        service: "openai",
        source: { kind: "onepassword", reference: "not-a-reference" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      store.register({
        id: "bad-aws",
        label: "Bad AWS ARN",
        service: "anthropic",
        source: {
          kind: "aws-secrets-manager",
          reference: "arn:aws:s3:::bucket",
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: CREDENTIAL_REFERENCE_SCHEMA_VERSION,
        entries: [
          {
            id: "duplicate-id",
            label: "One",
            service: "github",
            source: { kind: "github-cli" },
            createdAt: "2026-08-23T00:00:00.000Z",
            updatedAt: "2026-08-23T00:00:00.000Z",
          },
          {
            id: "duplicate-id",
            label: "Two",
            service: "github",
            source: { kind: "github-cli" },
            createdAt: "2026-08-23T00:00:00.000Z",
            updatedAt: "2026-08-23T00:00:00.000Z",
          },
        ],
      }),
      { encoding: "utf8", flag: "w" },
    );

    const corrupt = new CredentialReferenceStore(path);
    await expect(corrupt.status()).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
