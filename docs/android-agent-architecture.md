# Sovereign Android Runtime architecture

## Status

The Android developer preview lives under:

```text
apps/android-agent
```

Implemented checkpoints:

```text
M0 research, architecture and threat model
M1 explicitly enabled AccessibilityService and local status UI
M2 revision-bound observation and interaction primitives
M3 authenticated loopback Streamable HTTP MCP gateway
M4a immutable per-session tool receipts and audit diagnostics
M4b bounded single-use local approval broker and secure review surface
M5a revision-bound visible-app list/current/launch facades
M5b-1 bounded read-only active-notification status/list facades
M5c Accessibility screenshot metadata, surface status, and local MediaProjection consent ownership
M5d-1 bounded local MediaProjection frames in the metadata-only capture path
```

The current implementation does not provide a remote relay/tunnel, public consequential send/delete/install/settings facades, remote screenshot-byte delivery, notification open/reply/dismiss/delete/history tools, Shizuku, or Root. App, read-only active-notification, Accessibility/MediaProjection screenshot-metadata, and surface-status facades are implemented in source; real-device/OEM package visibility, Notification Access, Accessibility screenshot, and MediaProjection frame acceptance remain pending.

## Product boundary

```text
same-device MCP client
          |
          | HTTP Streamable MCP
          | 127.0.0.1 + mandatory Bearer
          v
Android Runtime
  Host / Origin / Auth / Session / Tool catalog / Authority
  Bounded local approval / Immutable intent-result receipts / audit health
          |
          v
Android Adapter
  Accessibility
  Apps / Notifications / Screenshot / Shizuku (future)
```

The Android app is not an ADB wrapper. Accessibility provides L1/L2 UI capabilities in-process. Shizuku may later provide bounded L3 system facades. Root is not part of the initial product line.

## Authority profiles

```text
L1 Observe
  android.system.info
  android.system.tool_manifest
  android.ui.observe
  android.screen.capture
  android.app.list
  android.app.current
  android.surface.status
  android.notification.status
  android.notification.list

L2 Interaction
  android.app.launch
  android.ui.click
  android.ui.long_press
  android.ui.set_text
  android.ui.swipe
  android.global.back
  android.global.home
  android.global.recents

L3 System (future, Shizuku optional)
  package.inspect
  package.install_approved
  package.uninstall_approved
  settings.read_allowlisted
  settings.write_allowlisted

L4 Root
  not implemented
```

An Android administrator, device owner, AccessibilityService, Shizuku shell identity, ADB shell and Root are separate authorities. The runtime must never present one as an implicit upgrade to another.

## Module layout

```text
apps/android-agent/
  app/src/main/kotlin/com/sovereign/runtime/android/
    MainActivity.kt
    SovereignAndroidApplication.kt
    runtime/
      AndroidAgentRuntime.kt
      AuthorityProfile.kt
      AuthorityPolicy.kt
    accessibility/
      SovereignAccessibilityService.kt
      AccessibilityServiceRegistry.kt
      AccessibilitySnapshotBuilder.kt
      AccessibilityActionEngine.kt
      UiSnapshotRegistry.kt
      UiModels.kt
      SensitiveSurfacePolicy.kt
    apps/
      AndroidAppModels.kt
      AndroidAppManager.kt
      PackageManagerAndroidAppPlatform.kt
    notification/
      AndroidNotificationRuntime.kt
      NotificationModels.kt
      NotificationSnapshotRegistry.kt
      NotificationContentPolicyRegistry.kt
      NotificationTextSanitizer.kt
      NotificationReadFacade.kt
      SovereignNotificationListenerService.kt
    screen/
      AccessibilityScreenshotController.kt
      MediaProjectionFrameProducer.kt
      ProjectionFrameSource.kt
      ProjectionScreenCaptureController.kt
      ScreenCaptureRouter.kt
      ScreenCaptureRegistry.kt
      ScreenCapturePolicy.kt
      ScreenCaptureLeaseRegistry.kt
      ProjectionStateMachine.kt
      ScreenProjectionRuntime.kt
      ScreenCaptureConsentActivity.kt
      ScreenProjectionForegroundService.kt
    surface/
      AndroidSurfaceRuntime.kt
      AndroidSurfaceStatus.kt
      ActiveSurfaceRegistry.kt
      SensitiveSurfacePolicy.kt
      SurfaceTextRedactor.kt
    approval/
      ApprovalModels.kt
      AndroidApprovalBroker.kt
    audit/
      AuditReceipt.kt
      ImmutableAuditReceiptStore.kt
      AndroidAuditLedger.kt
    gateway/
      GatewaySecurity.kt
      GatewayCredentialStore.kt
      AndroidToolCatalog.kt
      AndroidMcpToolServer.kt
      AndroidToolApproval.kt
      AndroidToolAudit.kt
      McpToolJson.kt
      McpSessionRegistry.kt
      LocalMcpServer.kt
      McpGatewayController.kt
      McpGatewayService.kt
      McpGatewayModels.kt
    ui/
      AgentScreen.kt
      MainViewModel.kt
```

## Accessibility lifecycle

The system starts the service only after the user explicitly enables it in Android settings.

```text
user enables service
  -> onServiceConnected
  -> registry publishes connected service
  -> runtime invalidates old snapshots

AccessibilityEvent that may change layout
  -> invalidate current snapshot revision

service interrupt/destroy
  -> clear service registry
  -> invalidate snapshots
```

The Activity cannot enable Accessibility itself. It opens the Android settings page and displays the resulting connection state.

## Snapshot contract

Schema:

```text
sar.ui-snapshot/v1
```

A snapshot contains:

```text
revision
capturedAtEpochMs
windowId
packageName
bounded node list
truncated flag
redaction count
```

Each node contains:

```text
ref
parentRef
depth
semantic role
bounded text/content description
view ID/class/package
screen bounds
action flags
editable/password/redacted flags
```

Internal locators additionally contain the child-index path and an identity fingerprint. Internal locators are never serialized to an MCP client.

## Revision-bound action flow

```text
android.ui.observe
  -> acquire rootInActiveWindow
  -> bounded iterative traversal
  -> redact protected surfaces
  -> publish latest revision and locators
  -> release framework node objects

android.ui.click(revision, ref)
  -> require L2
  -> require revision == latest revision
  -> reacquire rootInActiveWindow
  -> resolve child-index path
  -> verify window/package/class/view-ID/bounds fingerprint
  -> apply sensitive-surface policy
  -> ACTION_CLICK or bounded center-point gesture fallback
  -> invalidate revision on accepted action/gesture submission
  -> persistent receipt (M4)
```

No `AccessibilityNodeInfo` object is retained across calls.

## Traversal and action limits

```text
maximum nodes                  512
maximum depth                  40
maximum children               128 per node
maximum queued nodes           remaining node capacity
text/content description       256 characters each
set-text input                 4,000 characters
long press                     500..2,000 ms
swipe                          100..2,000 ms
MCP request body               1 MiB
live MCP sessions              8
```

A limit hit is explicit (`truncated=true` or a structured tool error), not silently ignored.

## Sensitive surfaces

Initial hard-deny/redaction rules:

- password nodes;
- nodes whose package cannot be verified;
- Android permission controller surfaces;
- System UI lock/credential surfaces;
- the runtime's own UI and future approval surface;
- user-configured package denylist.

Future screenshot and notification adapters must apply the same policy before returning content.

## Text input

The current implementation supports only `AccessibilityNodeInfo.ACTION_SET_TEXT`. It does not mutate the clipboard, install an IME, or execute `input text` through ADB/Shizuku/shell.

## Revision-bound app facade

M5a exposes three bounded tools:

```text
android.app.list
android.app.current
android.app.launch
```

Package visibility is intentionally narrower than ADB or `QUERY_ALL_PACKAGES`:

- the manifest declares only a MAIN/LAUNCHER `<queries>` intent;
- `PackageManager.queryIntentActivities` returns only launchable apps visible under Android package-visibility rules;
- disabled, non-exported, malformed and duplicate components are removed;
- at most 4,096 raw activities are inspected and 512 applications are returned by default;
- one deterministic launcher component is retained internally per package;
- activity/component names are not returned to MCP clients.

`android.app.list` publishes a 60-second app-list revision and opaque app refs. A launch call accepts only:

```text
revision
ref
```

It does not accept a raw package or component name. Before launch the runtime requires L2, verifies the current unexpired revision/ref, applies local package policy, re-queries the selected package, and requires the exact previously selected exported launcher component to remain available. A successful `startActivity` dispatch invalidates both the app-list revision and current Accessibility revision. The result explicitly reports `dispatchAccepted=true` and `confirmationRequired=true`; Android/OEM background-start policy can still prevent the target from becoming foreground, so the caller must confirm with `android.app.current` or `android.ui.observe`. Authority-profile changes invalidate the app-list snapshot. Dispatch failure or coroutine cancellation leaves the current list usable for a bounded retry.

`android.app.current` derives its package from the current Accessibility snapshot; it does not turn an arbitrary client package string into a discovery oracle. App labels and package names are bounded public results; audit receipts contain only canonical result/argument digests and, for current/launch results, a target-package SHA-256.

The package facade is not an installer, package manager, hidden-activity launcher or system-app enumerator. Real-device acceptance must cover Android/OEM package-visibility behavior and background-activity launch policy before remote-host claims are made.

## Read-only notification facade

M5b-1 exposes two L1 tools over an explicitly user-enabled `NotificationListenerService`:

```text
android.notification.status
android.notification.list
```

The Activity can only open Android's Notification Access settings; it cannot grant the listener privilege. Listener connect/disconnect, notification post/remove, authority-profile change, and runtime invalidation clear or replace the current in-memory snapshot.

`android.notification.status` returns only bounded listener state, current policy revision, optional snapshot revision, record count, and a normalized error code. `android.notification.list` returns at most 128 current active records in deterministic order. Neither tool reads history, dismisses notifications, exposes raw notification keys, serializes `PendingIntent`, returns arbitrary extras, or supports Open, Reply, Send, Clear, or Delete.

Privacy behavior is fail closed:

- package content is sensitive unless an explicit local content policy allows normal publication;
- authenticator, password-manager, banking, and payment classifications remain hard sensitive regardless of allowlist entries;
- contextual 4–8 digit OTP values are replaced with `[REDACTED_OTP]`;
- text and category values are bounded, normalized, stripped of control/format characters, and Sovereign's own notifications are excluded;
- source notification keys remain only in the process-local registry and are never returned or audited;
- the catalog contains no notification action tool, so an opaque notification ref cannot trigger Android execution.

The public list is observational only. Real-device acceptance must verify Notification Access grant/revocation, listener replacement/restart, update races, OEM delivery behavior, and fail-closed redaction before any remote-host claim is made.

## Local MCP gateway

M3 uses the official Kotlin MCP SDK 0.15.0 and Ktor CIO Streamable HTTP transport.

Hard defaults:

```text
listener host                  127.0.0.1
port                           ephemeral
path                           /mcp
methods                        GET / POST / DELETE
Bearer                         mandatory; no disable switch
Bearer entropy                 256 bits
credential at rest             Android Keystore AES-GCM + ciphertext preferences
Host                           exactly one validated loopback authority
Origin                         absent or one HTTP(S) loopback origin
browser CORS                   not enabled in M3
request URI                    exactly /mcp, no query or fragment
request body                   <= 1 MiB
live sessions                  <= 8
session IDs                    bounded allowlisted shape
foreground service             user-started and visibly notified
```

The server verifies the resolved connector after startup and fails if it did not bind exactly `127.0.0.1`. It uses both the official SDK DNS-rebinding plugin and Sovereign's stricter Host/Origin/Bearer policy.

The Bearer is not placed on the clipboard or included in notifications/logs. The local UI can reveal a connection configuration for 30 seconds. During that interval the Activity applies Android `FLAG_SECURE` so screenshots and recent-task previews are blocked, and the credential container clears its Accessibility semantics so another ordinary Accessibility service receives only a generic sensitive-credential description. Physical shoulder-surfing and a compromised OS remain outside this boundary.

The gateway exists only while its visible foreground service owns it:

- notification permission, app-level notifications, and the dedicated gateway notification channel are required before start;
- a separate high-importance local-approval channel alerts the user without exposing raw arguments or offering a direct Allow action; the ongoing Gateway notification also reflects a pending approval as a fallback;
- notification visibility is checked periodically;
- disabling app notifications or the dedicated channel triggers bounded listener shutdown;
- controller state carries explicit `listenerOwned`; ownership is cleared only after listener shutdown succeeds;
- an unconfirmed listener remains visible in foreground-service/error state and blocks restart, connection-secret reveal, and credential rotation;
- Stop closes initialized and in-progress transports and retries listener retirement once before reporting unresolved ownership;
- destroying the foreground service performs bounded synchronous approval cancellation and listener shutdown; if either a listener or any active/queued approval remains, the application process terminates fail-closed so no hidden process-local authority survives;
- service restart is `START_NOT_STICKY`; the user must start it again.

M3 is local-only. A future remote mode must use an outbound authenticated relay or supported secure tunnel. Binding `0.0.0.0` is not an onboarding option.

## Immutable tool receipts

M4a adds a local append-only receipt ledger under Android no-backup application storage. Gateway startup verifies the complete sequence and hash chain before opening the listener. A corrupt or unsafe ledger path prevents Gateway startup.

Audited tools declare:

```text
auditMode: intent-result
```

Diagnostic tools declare:

```text
auditMode: none
```

The diagnostic exemption is limited to bounded system information, the public tool manifest, audit health, and receipt listing. It prevents recursive receipt creation and preserves a local/authorized recovery surface when the ledger is unhealthy.

For an audited invocation:

```text
MCP session reservation
  -> bind initialized session ID
  -> derive 16-hex SHA-256 principal fingerprint
  -> commit intent receipt
  -> execute policy/adapter operation
  -> commit result receipt
  -> return result
```

The receipt stores only bounded metadata and hashes:

```text
sequence / receipt UUID / correlation UUID
principal fingerprint
phase / outcome / tool / current authority / read-only flag
argument names + canonical argument SHA-256
canonical result SHA-256
optional error code
optional UI revision SHA-256 / opaque UI ref / target-package SHA-256
previous receipt SHA-256 / receipt SHA-256
```

It never stores raw tool arguments, text input, raw tool results, Bearer credentials, or MCP session IDs. Receipt files use canonical JSON, create-only sequential names, bounded size/count, file flush, best-effort directory metadata flush, and post-publication reinspection. Unexpected files, sequence gaps, noncanonical bytes, unsafe paths, or digest-chain mismatch fail closed.

The intent must be committed before the adapter runs. Intent failure denies execution. If an operation completes but the result receipt cannot be committed, the MCP result becomes `AUDIT_RESULT_UNAVAILABLE`; for non-read-only actions the client is explicitly told that the action may have completed and must observe before retrying. Subsequent audited calls remain fail closed while append continues to fail.

The local UI exposes audit phase, latest sequence/digest prefix, durability capability, verification, and bounded errors. The chain is tamper-evident inside the unprivileged application sandbox; Root, same-UID compromise, instrumentation, or a compromised OS remain outside this guarantee.

## Single-use local approval

M4b adds a process-local broker for tools whose manifest declares:

```text
approvalMode: single-use
```

Current public L2 UI tools remain `approvalMode=session`; the broker does not silently increase their authority and no current public tool is single-use. It is a prerequisite for future send, reply, delete, install, uninstall, payment-adjacent, and settings-mutation facades.

Execution order is fixed:

```text
create approval UUID and trusted presentation metadata
  -> commit immutable intent receipt containing approval UUID
  -> enqueue bounded local approval request
  -> show ongoing Gateway status + high-priority local approval alert
  -> open FLAG_SECURE in-app review surface
  -> local Allow once / Deny / timeout / cancellation
  -> execute adapter operation only for active UUID + LOCAL_ALLOW
  -> commit linked result receipt containing the same approval UUID
```

Broker limits and semantics:

```text
active requests                 1
maximum active + queued         8
default expiry                  30 seconds
queue ordering                  FIFO
duplicate request UUID          denied
queued early resolution         denied
resolved/expired UUID replay    denied within a bounded 4,096-ID retirement cache
approval plan reuse             denied after the first authorize call
burst window                    10 seconds
burst warning threshold         5 requests
Gateway/profile stop            cancels all
```

Time is measured with Android monotonic elapsed time rather than wall clock. Expired queued requests are denied before presentation. Cancellation removes the exact pending UUID without approving or disturbing an unrelated active request. Recently resolved, timed-out, cancelled, duplicate, and overflow UUIDs remain in a bounded 4,096-entry retirement cache; request IDs are runtime-generated UUIDs, so eviction preserves bounded memory without making client-selected replay possible. Each approval plan also has an atomic one-shot guard, so even an internal caller cannot execute its authorization closure twice.

The local presentation is built only from trusted catalog metadata, current authority, a principal fingerprint, argument count, argument SHA-256 prefix, and optional hashed UI revision/opaque bounded ref. Raw argument values never enter the presentation. The notification deliberately has no Allow action; it opens the app, where the user must review and press **Allow once** or **Deny**. The Activity applies `FLAG_SECURE` before composition whenever either a Bearer secret or approval is visible, and reapplies it on resume. Sovereign's own package is already redacted and interaction-denied by its Accessibility adapter, preventing a remote client from clicking the approval surface through Sovereign itself. Another separately enabled Accessibility service remains a distinct authority; public consequential tools require a later device-credential/biometric or trusted-service gate before release.

Before any public single-use tool is registered, its deterministic schema, authority, package/surface, and target preflight must execute before the request is presented. A malformed or already-denied request must produce an audited denial without asking the user to approve it. M4b intentionally registers no public single-use tool until that per-facade preflight contract exists.

Gateway stop, foreground-service destruction, authority-profile changes, caller cancellation, timeout, queue overflow, duplicate IDs, stale local responses, or broker exceptions all deny execution. A stopped Gateway cancels approvals before closing transports so waiting handlers can produce denied/cancelled audit results where scheduling permits. The service also removes the separate approval notification explicitly during teardown.

## Tool catalog

Schema:

```text
sar.tool-manifest/v1
```

The catalog revision hashes the complete public definition: name, version, title, description, authority, approval mode, audit mode, side-effect annotations, required arguments and input schema. Tool handlers reject unknown arguments even if a client ignores the schema. Construction fails if a single-use definition does not also declare immutable `intent-result` audit. Current L2 interaction tools declare `approvalMode=session`, meaning the user must locally select L2 for the current application process. The runtime now implements `approvalMode=single-use`, but no current public tool uses it; future consequential facades must declare it explicitly before registration.

Tool failures return bounded structured codes such as:

```text
AUTHORITY_DENIED
ADAPTER_UNAVAILABLE
STALE_REVISION
UNKNOWN_REF
ACTION_REJECTED
INVALID_ARGUMENT
APPROVAL_DENIED
APPROVAL_TIMEOUT
APPROVAL_QUEUE_FULL
APPROVAL_DUPLICATE
APPROVAL_CANCELLED
APPROVAL_REPLAY
APPROVAL_MISMATCH
APPROVAL_UNAVAILABLE
APP_LIST_REQUIRED
STALE_APP_REVISION
UNKNOWN_APP_REF
APP_INTERACTION_DENIED
APP_QUERY_FAILED
APP_NOT_FOUND
APP_LAUNCH_REJECTED
AUDIT_UNAVAILABLE
AUDIT_RESULT_UNAVAILABLE
INTERNAL_ERROR
```

Cancellation is rethrown rather than converted into an ordinary tool error.

## Build toolchain

The Android project is isolated from pnpm and the TypeScript project graph. It uses:

```text
Gradle wrapper 8.14.4
Android Gradle Plugin 8.13.2
Kotlin 2.4.0
Ktor 3.5.1
MCP Kotlin SDK 0.15.0
compileSdk 36
targetSdk 36
minSdk 26
JDK 21 for local builds
```

The repository does not commit a machine-specific `sdk.dir` or `org.gradle.java.home`.

## Milestones

```text
M0 research, architecture and threat model                         complete
M1 AccessibilityService and local status UI                       complete
M2 revision-bound observe/click/long-press/set-text/swipe/actions complete
M3 loopback Streamable HTTP MCP + Bearer + tool manifest          complete in source; real-device acceptance pending
M4a session-bound immutable intent/result receipts                complete in source; real-device durability pending
M4b single-use local approval broker and secure review surface    complete in source; real-device notification/UI acceptance pending
M5a revision-bound visible-app list/current/launch facades         complete in source; real-device/OEM acceptance pending
M5b-1 bounded read-only active-notification status/list facades     complete in source; real-device/OEM acceptance pending
M5c Accessibility screenshot metadata and surface-status facades    complete in source; real-device/OEM acceptance pending
M5d-1 local MediaProjection frames in metadata-only capture           complete in source; real-device/OEM acceptance pending
M5d-2 remote screenshot-byte delivery and notification actions        not implemented
M6 outbound remote connection and reconnect model                  pending
M7 optional Shizuku L3 facades                                    pending
M8 real-device/OEM/Doze acceptance matrix                          pending
```

## Screen and notification adapters

`AndroidSurfaceRuntime` owns the current active-surface and shared bounded screenshot registry. `ScreenProjectionRuntime` separately owns local MediaProjection lifecycle, one process-local frame source, and the one-time lease registry. `AndroidNotificationRuntime` owns notification listener state, the local content-policy revision, and the current bounded notification snapshot:

```text
AndroidSurfaceRuntime
  ActiveSurfaceRegistry
  ScreenCaptureRegistry

ScreenProjectionRuntime
  ProjectionStateMachine
  ProjectionFrameSource
  ScreenCaptureLeaseRegistry

AndroidNotificationRuntime
  NotificationContentPolicyRegistry
  NotificationSnapshotRegistry
  NotificationReadFacade
```

Accessibility events advance an active-surface revision containing the foreground package and window. `android.screen.capture` first checks the local sensitive-surface policy, then uses the active process-local MediaProjection source when one exists or Android 11+ `AccessibilityService.takeScreenshot` otherwise. The projection path consumes a generation/session/package/window/dimension-bound five-second lease before asking for one frame. Both paths revalidate the same active surface after capture, bound dimensions and encoded bytes, and retain only one short-lived in-memory artifact. The MCP result is metadata-only.

The notification listener publishes at most 128 current records per snapshot, with monotonic revision, random nonce, and local policy revision. Raw system keys remain in the process-local registry. Package content is sensitive by default, hard-sensitive categories remain fully redacted, and contextual OTP sequences are removed before publication. `android.notification.status` and `android.notification.list` expose only bounded read-only views.

### MCP exposure status for screen and notifications

The loopback catalog registers four L1/read-only tools through the same generated catalog, authority, audit, and execution path used by other Observe tools:

```text
android.screen.capture
android.surface.status
android.notification.status
android.notification.list
```

`android.screen.capture` terminates in `AndroidSurfaceMcpFacade` and returns sanitized metadata only. The temporary result byte copy is cleared after metadata serialization. Although the internal facade has a bounded artifact reader for local tests, `android.screen.read` is absent from the public catalog and server dispatch. No `ImageContent` or base64 screenshot payload is returned remotely in this checkpoint.

The notification tools terminate in `NotificationReadFacade` and serialize only bounded public fields. The catalog contains no notification action tool.

## Notification adapter

The local notification adapter remains separate from MCP transport and action authority:

```text
Android NotificationListenerService
→ current local content-policy snapshot
→ bounded active-notification drafts
→ normalization and fail-closed redaction
→ revision/nonce/ref snapshot registry
→ read-only status/list facade
→ normal L1 policy and immutable audit pipeline
```

Snapshots are capped at 128 current active notifications and sorted deterministically. The public record contains an opaque ref, package name, bounded timestamps/metadata, and sanitized text fields. Android `StatusBarNotification.key`, raw extras, actions, and `PendingIntent` objects remain process-local. A new post/remove refresh, listener disconnect, policy/profile invalidation, or runtime reset replaces or clears the snapshot.

The public adapter is observation-only. No ContentIntent, RemoteInput, dismissal, clearing, or deletion primitive is registered. Internal source-key/ref resolution exists solely as bounded identity scaffolding and cannot be invoked through MCP.

## Screen capture lifecycle

When no local projection session is active, `AccessibilityScreenshotController` is the frame producer for `android.screen.capture` on Android 11 or newer:

1. require a connected Accessibility service and a current observed surface;
2. apply the local sensitive-package screenshot policy;
3. call `AccessibilityService.takeScreenshot` for the default display;
4. copy the hardware buffer into bounded software memory;
5. encode PNG within the 8 MiB and 16,777,216-pixel limits;
6. revalidate the exact active-surface revision, package, and window;
7. publish one 15-second in-memory artifact and return metadata only.

A new artifact zeroes the old byte array. Expiry and invalidation also zero it. The internal reader returns a defensive copy, but the public catalog intentionally omits `android.screen.read`, so remote clients receive no screenshot bytes in this checkpoint. Secure-window failures and uncertain processing fail closed.

## Local MediaProjection consent and frame ownership

MediaProjection remains split from MCP consent handlers. A non-exported `ScreenCaptureConsentActivity` presents Android's own consent UI, and a non-exported foreground service owns the returned process-local projection. The pure state machine binds every transition to monotonic time, generation, consent-request UUID, projection-session UUID, and deadline. It rejects stale/malformed results and clears ownership on denial, timeout, callback stop, explicit Stop, fatal failure, service destruction, session expiry, or process recovery. The result Intent and projection token are never persisted.

After a valid grant, that foreground service creates one `VirtualDisplay` and one active `ImageReader`-backed `MediaProjectionFrameProducer`. Size and visibility callbacks update the source without creating a second virtual display for the token. A capture uses `ScreenCapturePolicy`, issues and consumes a one-time five-second lease bound to generation, session, package, active-surface revision, and dimensions, attaches the frame surface only for that request, then waits at most two seconds for a frame and detaches after success, failure, timeout, or close. Row/pixel stride and buffer length are checked; black or transparent protected output fails closed; PNG encoding retains the existing 16,777,216-pixel and 8 MiB limits. Temporary row, bitmap, encoder, rejected-frame, and MCP-result buffers are cleared or released on every exit path.

The exact projection source and active package/window/revision are checked again before publication. A lifecycle or surface mismatch zeroes the frame and publishes nothing. Success uses the same single 15-second `ScreenCaptureRegistry` artifact as Accessibility capture. No MCP tool can open consent, issue a lease directly, call `android.screen.read`, or receive MediaProjection bytes.
