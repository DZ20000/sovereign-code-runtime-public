import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type {
  DesktopGeminiConnectionConfigurationInput,
  DesktopGeminiConnectionStatus,
  DesktopProtectedValueUpdate,
  SovereignConnectionBundle,
} from "@sovereign/control-plane-contract";
import {
  createGeminiGatewayBridge,
  createGeminiTokenVerifier,
  loadGeminiAuthorizationServer,
} from "@sovereign/gateway/runtime";
import {
  EMPTY_GEMINI_CONNECTION_SETTINGS,
  GEMINI_CONNECTION_ERRORS as errors,
  geminiConfigurationInputSchema,
  decodeGeminiSecret,
  encodeGeminiSecret,
  readGeminiConnectionSettings,
  writeGeminiConnectionSettings,
  type GeminiConnectionSettings,
} from "./gemini-connection-settings.js";

export interface GeminiConnectionOptions {
  readonly userDataPath: string;
  readonly shell: {
    protectSecret(value: string): Promise<string | null>;
    restoreSecret(value: string): Promise<{ readonly value: string; readonly encoded: string } | null>;
  };
  readonly localConnection: () => SovereignConnectionBundle | null;
  readonly isAuthoritative: () => boolean;
  readonly allowAutomaticRestore: boolean;
}

// Only used for read-only secret restoration. A late result cannot write or start a listener.
function readWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export class GeminiConnectionManager {
  readonly #options: GeminiConnectionOptions;
  readonly #settingsPath: string;
  #settings: GeminiConnectionSettings = { ...EMPTY_GEMINI_CONNECTION_SETTINGS };
  #loaded = false;
  #blocked = false;
  #disposed = false;
  #phase: DesktopGeminiConnectionStatus["phase"] = "unconfigured";
  #lastError: string | null = null;
  #server: Server | null = null;
  #bridge: Awaited<ReturnType<typeof createGeminiGatewayBridge>> | null = null;
  #listenEndpoint: string | null = null;
  #pendingStart: AbortController | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: GeminiConnectionOptions) {
    this.#options = options;
    this.#settingsPath = join(options.userDataPath, "gemini-connection.json");
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  #snapshot(): DesktopGeminiConnectionStatus {
    return {
      phase: this.#phase,
      configuration: this.#settings.configuration === null ? null : { ...this.#settings.configuration },
      hasOwnerSubject: this.#settings.ownerSubjectEncrypted !== null,
      hasIntrospectionAuthorization: this.#settings.introspectionAuthorizationEncrypted !== null,
      listenEndpoint: this.#listenEndpoint,
      lastError: this.#lastError,
    };
  }

  #savedPhase(): "saved" | "unconfigured" {
    return this.#settings.configuration !== null && this.#settings.ownerSubjectEncrypted !== null &&
      this.#settings.introspectionAuthorizationEncrypted !== null ? "saved" : "unconfigured";
  }

  async #load(reload = false): Promise<boolean> {
    if (this.#loaded && !reload) return !this.#blocked;
    this.#loaded = true;
    try {
      this.#settings = await readGeminiConnectionSettings(this.#settingsPath);
      this.#blocked = false;
      if (this.#server === null) {
        this.#phase = this.#savedPhase();
        this.#lastError = null;
      }
      return true;
    } catch {
      this.#blocked = true;
      this.#phase = "error";
      this.#lastError = errors.read;
      return false;
    }
  }

  #assertOwner(): void {
    if (this.#disposed || !this.#options.isAuthoritative()) throw new Error(errors.owner);
  }

  #attempt(): AbortController {
    this.#pendingStart?.abort();
    const attempt = new AbortController();
    this.#pendingStart = attempt;
    return attempt;
  }

  async #commit(settings: GeminiConnectionSettings): Promise<void> {
    await writeGeminiConnectionSettings(this.#settingsPath, settings);
    this.#settings = settings;
  }

  async #protect(
    purpose: "ownerSubject" | "introspectionAuthorization",
    update: DesktopProtectedValueUpdate,
    previous: string | null,
  ): Promise<string | null> {
    if (update.action !== "replace") return update.action === "keep" ? previous : null;
    try {
      const encoded = await this.#options.shell.protectSecret(encodeGeminiSecret(purpose, update.value));
      if (encoded === null || encoded.length === 0 || encoded.length > 16_384) throw new Error();
      return encoded;
    } catch {
      throw new Error(errors.protect);
    }
  }

  read(): Promise<DesktopGeminiConnectionStatus> {
    return this.#serialize(async () => {
      await this.#load();
      return this.#snapshot();
    });
  }

  configure(input: DesktopGeminiConnectionConfigurationInput): Promise<DesktopGeminiConnectionStatus> {
    const parsed = geminiConfigurationInputSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new Error(errors.invalid));
    const attempt = this.#attempt();
    return this.#serialize(async () => {
      this.#assertOwner();
      if (!await this.#load(true)) throw new Error(errors.read);
      const { ownerSubject, introspectionAuthorization, ...configuration } = parsed.data;
      const [ownerSubjectEncrypted, introspectionAuthorizationEncrypted] = await Promise.all([
        this.#protect("ownerSubject", ownerSubject, this.#settings.ownerSubjectEncrypted),
        this.#protect("introspectionAuthorization", introspectionAuthorization, this.#settings.introspectionAuthorizationEncrypted),
      ]);
      this.#assertOwner();
      await this.#commit({ ...this.#settings, configuration, ownerSubjectEncrypted, introspectionAuthorizationEncrypted });
      await this.#close();
      if (this.#settings.enabled && !attempt.signal.aborted) await this.#startListener(attempt);
      return this.#snapshot();
    });
  }

  start(): Promise<DesktopGeminiConnectionStatus> {
    const attempt = this.#attempt();
    return this.#serialize(async () => {
      this.#assertOwner();
      if (attempt.signal.aborted) return this.#snapshot();
      if (!await this.#load(true)) {
        await this.#close();
        return this.#fail(errors.read);
      }
      if (this.#savedPhase() === "unconfigured") return this.#missingConfiguration();
      await this.#commit({ ...this.#settings, enabled: true });
      if (!attempt.signal.aborted) await this.#startListener(attempt);
      return this.#snapshot();
    });
  }

  cancelPendingOperations(): void {
    this.#pendingStart?.abort();
    this.#bridge?.dispose();
  }

  stop(): Promise<DesktopGeminiConnectionStatus> {
    this.cancelPendingOperations();
    return this.#serialize(async () => {
      this.#assertOwner();
      const loaded = await this.#load(true);
      // Even an unreadable file must not prevent closing our own listener.
      await this.#close();
      if (!loaded) return this.#fail(errors.read);
      await this.#commit({ ...this.#settings, enabled: false });
      return this.#snapshot();
    });
  }

  restore(): Promise<DesktopGeminiConnectionStatus> {
    if (!this.#options.allowAutomaticRestore || !this.#options.isAuthoritative() || this.#disposed) {
      return Promise.resolve(this.#snapshot());
    }
    const attempt = this.#attempt();
    return this.#serialize(async () => {
      if (attempt.signal.aborted || !this.#options.isAuthoritative() || this.#disposed) return this.#snapshot();
      if (!await this.#load(true)) {
        await this.#close();
        return this.#fail(errors.read);
      }
      if (this.#settings.enabled) await this.#startListener(attempt);
      else await this.#close();
      return this.#snapshot();
    });
  }

  suspend(): Promise<DesktopGeminiConnectionStatus> {
    this.cancelPendingOperations();
    return this.#serialize(async () => {
      await this.#close();
      return this.#snapshot();
    });
  }

  shutdown(): Promise<DesktopGeminiConnectionStatus> {
    this.#disposed = true;
    return this.suspend();
  }

  #missingConfiguration(): DesktopGeminiConnectionStatus {
    this.#phase = "unconfigured";
    this.#lastError = errors.configuration;
    return this.#snapshot();
  }

  #fail(message: string): DesktopGeminiConnectionStatus {
    this.#phase = "error";
    this.#lastError = message;
    return this.#snapshot();
  }

  async #close(): Promise<void> {
    this.#bridge?.dispose();
    this.#bridge = null;
    const server = this.#server;
    this.#server = null;
    this.#listenEndpoint = null;
    if (server !== null) await closeServer(server);
    this.#phase = this.#savedPhase();
    this.#lastError = null;
  }

  async #startListener(attempt: AbortController): Promise<void> {
    if (this.#server !== null) return;
    const configuration = this.#settings.configuration;
    const { ownerSubjectEncrypted, introspectionAuthorizationEncrypted } = this.#settings;
    if (configuration === null || ownerSubjectEncrypted === null || introspectionAuthorizationEncrypted === null) {
      this.#missingConfiguration();
      return;
    }
    let localConnection: SovereignConnectionBundle | null;
    try { localConnection = this.#options.localConnection(); } catch { localConnection = null; }
    if (localConnection === null) {
      this.#fail(errors.gateway);
      return;
    }
    this.#phase = "starting";
    this.#lastError = null;
    const signal = AbortSignal.any([attempt.signal, AbortSignal.timeout(8_000)]);
    let failure: string = errors.restore;
    let server: Server | null = null;
    let bridge: Awaited<ReturnType<typeof createGeminiGatewayBridge>> | null = null;
    const binding = new AbortController();
    try {
      signal.throwIfAborted();
      const [owner, authorization] = await readWithSignal(Promise.all([
        this.#options.shell.restoreSecret(ownerSubjectEncrypted),
        this.#options.shell.restoreSecret(introspectionAuthorizationEncrypted),
      ]), signal);
      if (!owner?.value || !authorization?.value) throw new Error();
      const ownerSubject = decodeGeminiSecret("ownerSubject", owner.value);
      const introspectionAuthorization = decodeGeminiSecret("introspectionAuthorization", authorization.value);
      signal.throwIfAborted();
      failure = errors.discovery;
      const metadata = await loadGeminiAuthorizationServer(configuration.oauthDiscoveryUrl, signal);
      const verifier = createGeminiTokenVerifier({
        publicEndpoint: configuration.publicMcpUrl,
        introspectionUrl: configuration.introspectionUrl,
        introspectionAuthorization,
        clientId: configuration.clientId,
        ownerSubject,
      });
      failure = errors.bridge;
      bridge = await createGeminiGatewayBridge({
        publicEndpoint: configuration.publicMcpUrl,
        authorizationServer: metadata,
        verifyToken: verifier,
        localConnection,
        reloadLocalConnection: async () => this.#options.localConnection(),
        startupSignal: signal,
      });
      signal.throwIfAborted();
      this.#assertOwner();
      failure = errors.listen;
      server = createServer(bridge);
      const ownedServer = server;
      server.on("error", () => {
        void this.#serialize(async () => {
          if (this.#server !== ownedServer) return;
          await this.#close();
          this.#fail(errors.listen);
        });
      });
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          signal.removeEventListener("abort", abort);
          ownedServer.off("error", failed);
          ownedServer.off("listening", ready);
        };
        const abort = () => {
          binding.abort();
          cleanup();
          reject(signal.reason);
        };
        const failed = (error: NodeJS.ErrnoException) => {
          if (error.code === "EADDRINUSE") failure = errors.port;
          cleanup();
          reject(error);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        ownedServer.once("error", failed);
        ownedServer.once("listening", ready);
        if (signal.aborted) abort();
        else ownedServer.listen({ host: "127.0.0.1", port: configuration.loopbackPort, signal: binding.signal });
      });
      signal.throwIfAborted();
      this.#assertOwner();
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error();
      this.#server = server;
      this.#bridge = bridge;
      this.#listenEndpoint = `http://127.0.0.1:${address.port}/mcp`;
      this.#phase = "listening";
    } catch {
      bridge?.dispose();
      binding.abort();
      if (server !== null) await closeServer(server);
      if (attempt.signal.aborted) {
        this.#phase = this.#savedPhase();
        this.#lastError = null;
      } else {
        this.#fail(signal.aborted ? errors.timeout : failure);
      }
    }
  }
}
