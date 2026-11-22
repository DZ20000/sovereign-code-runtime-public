export type DesktopGeminiConnectionPhase =
  | "unconfigured"
  | "saved"
  | "starting"
  | "listening"
  | "error";

export interface DesktopGeminiConnectionConfiguration {
  readonly publicMcpUrl: string;
  readonly oauthDiscoveryUrl: string;
  readonly introspectionUrl: string;
  readonly clientId: string;
  readonly loopbackPort: number;
}

/** Secret values are accepted only by configure; status never returns them. */
export type DesktopProtectedValueUpdate =
  | { readonly action: "keep" | "forget" }
  | { readonly action: "replace"; readonly value: string };

export interface DesktopGeminiConnectionConfigurationInput
  extends DesktopGeminiConnectionConfiguration {
  readonly ownerSubject: DesktopProtectedValueUpdate;
  readonly introspectionAuthorization: DesktopProtectedValueUpdate;
}

export interface DesktopGeminiConnectionStatus {
  readonly phase: DesktopGeminiConnectionPhase;
  readonly configuration: DesktopGeminiConnectionConfiguration | null;
  readonly hasOwnerSubject: boolean;
  readonly hasIntrospectionAuthorization: boolean;
  /** The local listener endpoint; listening does not establish client identity. */
  readonly listenEndpoint: string | null;
  /** A fixed, sanitized explanation; never raw upstream or credential data. */
  readonly lastError: string | null;
}
