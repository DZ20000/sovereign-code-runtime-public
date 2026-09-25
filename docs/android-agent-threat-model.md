# Sovereign Android Runtime threat model

## Assets

- UI text and Accessibility metadata from foreground applications;
- ability to click, type, navigate, launch global Android actions, enumerate visible launcher apps, and start an exported launcher activity;
- local MCP Bearer credential and active session IDs;
- protected Android Keystore key and encrypted credential preferences;
- active notification metadata/content, bounded in-memory Accessibility/MediaProjection screenshot artifacts, and future messages/contacts;
- future device identity and outbound relay credential;
- future Shizuku Binder authority and package/settings capabilities;
- active single-use approval requests, local decisions and anti-replay identity;
- audit evidence proving what principals requested, what the user approved, and what the phone executed.

## Principals

```text
local device user
approved same-device MCP client
future approved remote MCP principal
unapproved local/network client
browser content capable of localhost requests
foreground Android application
malicious accessibility surface
Sovereign Android application
Android system services
future relay/tunnel
future Shizuku server
```

## Trust boundaries

1. Same-device client to loopback MCP listener.
2. Future relay/tunnel to MCP session.
3. MCP session to authority/policy/approval middleware.
4. Approval broker and protected presentation to the local device user.
5. Runtime to Android adapter.
6. Android adapter to AccessibilityService callbacks.
7. Android app facade to PackageManager visibility and activity launch.
8. Read-only notification facade to the user-enabled NotificationListenerService and active StatusBarNotification surface.
9. Snapshot/action/app/notification data to MCP output.
10. Application UI to locally revealed Bearer credential.
11. Application process to Android Keystore/preferences.
12. MCP session and tool middleware to immutable audit storage.
13. Future application process to Shizuku Binder server.
14. Candidate update/install boundary.

## Primary threats and mitigations

### Stale UI reference causes action on another control

Threat:

- the model observes a button;
- the UI changes;
- the same coordinate or semantic ID now represents another action.

Mitigations:

- every ref is valid only for one opaque snapshot revision;
- layout-changing Accessibility events invalidate the revision;
- actions reacquire the root and resolve the original child-index path;
- window, package, class, view ID, bounds and sensitivity fingerprint are rechecked;
- coordinate gestures are fallback only after node verification;
- accepted node actions and submitted gestures invalidate the revision.

### Password, OTP or protected-surface disclosure

Mitigations:

- redact text and content descriptions for password nodes;
- redact unknown packages, denied packages, SystemUI, permission controller and Sovereign UI;
- never return node text from protected credential surfaces;
- Accessibility screenshots refuse protected, unknown, secure-window, authenticator, password-manager, banking/payment, and device-administration surfaces;
- the active-notification adapter applies fail-closed package policy, removes hard-sensitive content, masks contextual OTP values, and exposes no notification action tool;
- no clipboard-read tool in the initial catalog;
- logs and receipts store hashes/metadata rather than action text where possible.

### Remote action reaches a protected system surface

Mitigations:

- default protected package list for permission controller, SystemUI and the runtime itself;
- user-configurable package denylist;
- runtime approval/control UI cannot be controlled through its own Accessibility adapter;
- L2 cannot access future package/settings/Shizuku functions;
- sensitive actions require local approval or are hard-denied.

### Accessibility tree denial of service

Mitigations:

- iterative traversal;
- strict node, queued-node, depth, child and text limits;
- truncated result is explicit;
- no long-lived `AccessibilityNodeInfo` references;
- Android main-thread work is bounded;
- network requests use one revision-bound adapter operation rather than retaining framework objects.

### Gesture abuse or off-screen coordinates

Mitigations:

- coordinates checked against current display metrics;
- duration and stroke count bounded;
- referenced actions prefer node actions;
- raw swipe requires a current UI revision and L2;
- no multi-touch or arbitrary gesture path in M3;
- submitting any gesture invalidates the revision even if the waiting coroutine is later cancelled.

### Text injection leaks through clipboard

Mitigations:

- `ACTION_SET_TEXT` only;
- no automatic clipboard fallback;
- text length bounded;
- target must be verified, enabled, editable and non-password;
- later IME support requires a separate capability and local enablement.

### Loopback listener is reached by an untrusted local process

Mitigations:

- 256-bit random Bearer is mandatory for every GET/POST/DELETE;
- no authentication-disable option;
- Bearer comparison uses fixed-shape input and constant-time byte comparison;
- credential is generated/stored through Android Keystore AES-GCM and ciphertext-only preferences;
- listener binds to `127.0.0.1` on an ephemeral port and verifies the resolved connector;
- endpoint is not advertised through Android discovery, LAN binding or an exported service;
- user explicitly starts and stops the foreground service.

The current security boundary assumes the unprivileged Android application sandbox. Root, instrumentation, debugger attachment, compromised OS or another process running as the same application UID can bypass app-level secret, approval and receipt protection and are outside M4b's guarantee.

### Browser DNS rebinding or localhost request forgery

Mitigations:

- exactly one validated loopback Host header;
- absent Origin is permitted for native clients, but a present Origin must be one HTTP(S) loopback origin;
- duplicate Host, Origin or Authorization headers fail closed;
- the official MCP SDK DNS-rebinding plugin remains enabled in addition to Sovereign's stricter checks;
- the complete request URI must be exactly `/mcp`; query strings and fragments are rejected before session creation;
- M3 does not install permissive CORS response headers and is not advertised as an arbitrary browser-JavaScript endpoint;
- any browser request that can still reach the listener requires the unknown Bearer.

### Bearer credential is exposed through UI, notification or logs

Mitigations:

- notifications display only a short SHA-256 fingerprint;
- endpoint and full Authorization header are revealed only through an explicit local action;
- reveal expires after 30 seconds and Sovereign never writes it to the clipboard;
- while visible, Android `FLAG_SECURE` blocks screenshots and recent-task previews;
- the credential container clears its Accessibility semantics and exposes only a generic sensitive-credential description to ordinary Accessibility services;
- Sovereign's own package remains redacted and non-interactive through its adapter;
- normal state, MCP tools and error messages expose fingerprint only;
- credential rotation is available only when no listener is owned.

Physical shoulder-surfing, a compromised OS, Root, debugger/instrumentation access, or a same-UID process can still observe an explicitly displayed secret. The UI labels it as a password-equivalent and future screenshot tooling must hard-deny the runtime package.

### Invisible or orphaned foreground listener

Mitigations:

- Android notification permission, app-level notifications, and the dedicated gateway channel are required before start;
- foreground service is non-exported, user-started and `START_NOT_STICKY`;
- persistent notification has a Stop action and displays listener errors without the Bearer;
- notification visibility is rechecked every five seconds, including channel importance;
- disabling notifications or the dedicated channel initiates bounded shutdown;
- controller state retains explicit listener ownership until shutdown succeeds;
- unconfirmed ownership blocks restart and credential rotation, and keeps the foreground service visible for another Stop attempt;
- Stop closes initialized and in-progress transports and retries listener retirement once;
- service destruction performs bounded synchronous approval cancellation and listener shutdown; if either listener ownership or any active/queued approval remains, Sovereign terminates its own application process fail-closed so hidden process-local authority cannot survive.

### Request-body or session exhaustion

Mitigations:

- Ktor route body limit and MCP transport body limit are both 1 MiB;
- no-session requests reserve one of eight fair semaphore permits before server/session creation;
- initialized and in-progress transports are both tracked;
- failed/uninitialized transports release their permits;
- the ninth live session receives HTTP 429;
- Stop closes every reservation and resets the visible session count;
- session IDs use a bounded allowlisted shape.

### Malformed or schema-confused tool input

Mitigations:

- versioned catalog includes the complete public input schema and side-effect annotations;
- tool handlers reject unknown arguments rather than trusting client-side schema enforcement;
- revision/ref values have narrow shapes;
- integer/number/string values are type-checked without coercion;
- errors use bounded structured codes and never include the Bearer;
- coroutine cancellation is rethrown rather than converted into a successful/ordinary error response.

### Package enumeration or confused app launch

Threats:

- a broad package permission reveals hidden or non-launchable applications;
- the model supplies an arbitrary package/component and launches an internal or newly substituted activity;
- an app-list result is replayed after installation state or local policy changes;
- a protected package is launched through an old ref;
- Android/OEM background-activity policy silently rejects or redirects a launch.

Mitigations:

- the manifest does not request `QUERY_ALL_PACKAGES`; it declares only a MAIN/LAUNCHER visibility query;
- listing uses only visible launcher intent results and removes disabled, non-exported, malformed and duplicate components;
- the public list exposes package/label plus an opaque app ref, never the selected activity name;
- `android.app.launch` accepts only the current short-lived app-list revision and ref, not a raw package or component;
- the selected exact launcher component is re-queried and revalidated immediately before launch;
- local protected-package policy is evaluated both while listing and before launch;
- authority-profile change, expiry and an accepted launch dispatch invalidate the app-list revision;
- an accepted launch dispatch invalidates the Accessibility snapshot so old UI refs cannot cross applications;
- the result explicitly distinguishes an accepted dispatch from confirmed foreground presentation and requires `android.app.current` or `android.ui.observe` confirmation;
- structured errors distinguish missing list, stale revision, unknown ref, local policy denial, query failure, disappeared component and Android launch rejection;
- real-device/OEM acceptance must prove package visibility and background-launch behavior before remote-host claims are made.

### Notification disclosure or stale observation

Threats:

- Notification Access exposes sensitive current content even without Root;
- an authentication, OTP, financial, password-manager, or private-message notification leaks through title, text, subtext, category, or extras;
- a stale ref is presented as if it still describes the current notification surface;
- raw Android notification identity, extras, actions, or `PendingIntent` objects cross the MCP or audit boundary;
- listener revocation/replacement leaves old records available;
- a permissive package override accidentally declassifies a hard-sensitive package.

Mitigations:

- the user must explicitly enable **Sovereign Notification Adapter** in Android Notification Access settings; the app cannot grant this authority;
- only current active notifications are queried; history, raw keys, arbitrary extras, action objects, reply inputs, delete/dismiss controls, and raw `PendingIntent` objects never cross MCP;
- snapshots and text are bounded, deterministic, normalized, stripped of control/format characters, and exclude Sovereign's own notifications;
- package content is sensitive by default; authenticator, password-manager, banking, and payment classifications remain hard sensitive and cannot be allowlisted for content;
- contextual OTP digits are replaced before publication;
- post/remove refresh, listener connect/disconnect, policy/profile change, and runtime invalidation replace or clear the current snapshot;
- status/list are L1 read-only tools and the public catalog contains no notification action handler, so an opaque ref cannot execute Android code;
- real-device/OEM acceptance must verify listener grant/revocation, listener replacement/restart, update races, snapshot clearing, and fail-closed redaction before remote-host claims are made.

### Audit receipt tampering, truncation or rollback

Mitigations:

- Gateway startup verifies the complete sequential receipt inventory and SHA-256 chain before binding the MCP listener;
- each receipt has a create-only sequence filename, receipt UUID, correlation UUID, previous-receipt digest and self-digest;
- receipt bytes must exactly match canonical JSON, so appended whitespace or alternate encodings do not pass verification;
- sequence gaps, duplicate destinations, unexpected directory entries, symbolic-link paths, changed files, oversized files, malformed schemas and digest mismatch fail closed;
- the latest receipt is re-read before each append so post-start modification is detected before the next audited action;
- receipt files live under Android no-backup app storage and are excluded from backup/device transfer;
- diagnostic status and listing tools remain available without recursively generating more receipts.

The chain is tamper-evident within the unprivileged app sandbox. Root, same-UID compromise, instrumentation, storage rollback performed by a compromised OS, or deletion followed by complete app-data replacement remain outside this guarantee.

### Audit receipts disclose user content or session credentials

Mitigations:

- receipts store argument names and canonical SHA-256 digests, never raw argument values;
- raw text input, raw Accessibility output, raw tool results, Bearer credentials and MCP session IDs are not persisted;
- the MCP principal is represented only by a 16-hex SHA-256 fingerprint bound to the initialized session;
- UI revisions and target package names are hashed; the opaque bounded UI ref may be stored only to correlate one revision-bound action;
- error codes and explanatory data are bounded and selected by trusted runtime code rather than copied from device content;
- integration tests scan persisted receipts to prove that sensitive fixture text and session IDs are absent.

### Action executes without durable intent or loses its result receipt

Mitigations:

- every audited tool commits an intent receipt before policy or adapter execution;
- if intent persistence fails, the operation is not invoked and returns `AUDIT_UNAVAILABLE`;
- success, denial, failure and cancellation attempt a linked result receipt with the same correlation ID;
- if a result receipt fails after a read, the response reports `AUDIT_RESULT_UNAVAILABLE` instead of presenting an unaudited success;
- if a result receipt fails after a potentially side-effecting action, the response explicitly states that the action may have completed and requires a fresh observation before retry;
- subsequent audited calls continue to fail at intent persistence while the ledger cannot append;
- Gateway startup itself is denied when ledger verification fails, so corruption cannot silently downgrade audit enforcement.

### Approval spoofing, replay or confused local consent

Mitigations:

- only tools whose trusted versioned catalog entry declares `approvalMode=single-use` enter the broker;
- construction rejects any single-use definition that does not also declare immutable `intent-result` audit;
- before a public single-use facade is registered, deterministic schema, authority, target, package and sensitive-surface preflight must reject malformed or already-denied calls before showing a prompt;
- each request receives a runtime-generated UUID and is bound to the MCP principal fingerprint, trusted tool name, current authority and canonical argument SHA-256;
- raw argument values and untrusted device text do not enter the approval title, message or detail;
- exactly one request is active; queued UUIDs cannot be approved before presentation;
- a UUID is removed on allow, deny, timeout or cancellation, then retained in a bounded 4,096-entry retirement cache; recent reuse is denied, while runtime-generated UUID entropy makes collision after bounded eviction negligible;
- the broker result must carry the exact request UUID; a mismatched result returns `APPROVAL_MISMATCH` without executing;
- duplicate pending or recently retired UUIDs are denied rather than merged or rebound;
- **Allow once** authorizes only the closure associated with that exact request; the approval plan has an atomic one-shot guard and a second internal authorization attempt returns `APPROVAL_REPLAY`;
- both the immutable intent and result receipts include the same approval UUID, allowing later correlation of request, decision and outcome;
- current public catalog tools remain session-approved; no consequential public facade is added merely by implementing the broker.

### Approval queue flooding or coercive request bursts

Mitigations:

- active plus queued requests are bounded to eight;
- overflow is immediately denied and never replaces the active request;
- FIFO ordering prevents a later request from jumping ahead;
- a 30-second monotonic expiry applies to each request, including time spent queued;
- expired queued requests are denied before they can become active;
- a ten-second burst window marks rapid requests in the local UI;
- Gateway stop, foreground-service destruction, authority-profile changes and caller cancellation revoke pending requests;
- broker exceptions fail closed as `APPROVAL_UNAVAILABLE` without invoking the adapter operation.

### Approval surface is hidden, captured or remotely clicked

Mitigations:

- the ongoing Gateway notification reflects pending approval and a separate high-importance channel posts a heads-up local alert;
- the alert contains only trusted tool title and remaining time, has no direct Allow action, and opens the app for review;
- `FLAG_SECURE` is enabled while an approval or Bearer secret is visible, blocking ordinary screenshots and recent-task previews;
- Sovereign's own package is redacted and interaction-denied by its Accessibility adapter, so MCP tools cannot click the approval buttons;
- another separately enabled Accessibility service or a compromised OS can still synthesize local input and is not defeated by `FLAG_SECURE`; before any public consequential single-use facade ships, real-device acceptance must add device-credential/biometric confirmation or an explicit trusted-accessibility-services policy;
- only the current active UUID can be resolved by the UI; stale or queued UI actions fail;
- if notifications are globally hidden or the required Gateway channel disappears, the foreground service shuts down and cancels approvals;
- disabling only the optional high-priority approval channel cannot grant authority: the fallback Gateway notification remains visible and an unseen request simply times out.

### Accessibility service impersonation or disabled state

Mitigations:

- app reports exact component and service connection state;
- user explicitly enables the service in Android settings;
- no attempt to enable it silently through secure settings;
- runtime tools fail closed when the service is absent;
- reconnect clears all snapshot refs.

### Root or Shizuku authority escalation

Mitigations:

- Root is absent from the initial product line;
- Shizuku is a distinct future optional L3 adapter;
- verify Shizuku server UID/mode and permission before consequential facades;
- expose bounded package/settings operations instead of general shell;
- no unattended persistence of broad L3;
- service restart/boot resets high-impact leases.

### Confused deputy between multiple devices

Mitigations for future remote mode:

- unique device ID and credential per installation;
- controller request explicitly binds one device ID;
- device and controller tokens are separate;
- audit receipt includes device, session, tool and snapshot revision;
- no shared Tunnel/relay identity across devices.

### Malicious application crafts deceptive Accessibility nodes

Mitigations:

- node text/description is untrusted data;
- node strings are never interpreted as commands, URLs or tool names;
- bounded output and control-character normalization;
- package identity comes from system node/window metadata;
- action policy evaluates package and node flags independently of displayed text;
- future model prompts label Accessibility data as untrusted device content.

### Distribution-policy misuse

Mitigations:

- initial builds are developer/enterprise sideloaded;
- foreground notification and in-app disclosure are visible;
- per-app policy and persistent audit arrive before remote general use;
- no claim of accessibility assistance unless the product genuinely satisfies that purpose;
- Google Play distribution is a separate policy/legal release gate.

## Hard invariants through M5c

```text
no Root
no Shizuku
no arbitrary shell or ADB facade
no QUERY_ALL_PACKAGES permission
no raw package/component argument for app launch
no app launch without current unexpired app-list revision and opaque ref
no app launch when exact exported launcher component or local package policy changed
no silent Notification Access enablement
no notification history, raw key, raw PendingIntent, arbitrary extras, action dispatch, reply, dismissal, or deletion facade
no notification content publication without the current fail-closed local policy revision
no hard-sensitive authenticator/password-manager/banking/payment content allowlist override
no notification record retained after listener/profile/runtime invalidation
no remote screenshot-byte delivery; android.screen.capture returns metadata only and android.screen.read is absent
no screenshot publication when the active surface changes or local sensitive-surface policy denies it
no MCP-triggered MediaProjection consent or direct lease API; only android.screen.capture may internally consume one lease while valid local projection ownership is active, and it returns metadata only
no LAN/public listener
no permissive browser CORS surface
no disabled authentication
no plaintext Bearer in preferences, notification or ordinary state
no secret reveal without FLAG_SECURE and cleared Accessibility semantics
no retained AccessibilityNodeInfo
no interaction without current revision
no password/protected-node text or interaction
no silent Accessibility or notification enablement
no clipboard fallback
no remote control of the runtime's own UI
no clearing listener ownership before confirmed shutdown
no restart or credential rotation while a listener remains owned
no hidden gateway after foreground-service or notification loss
no Gateway listener before immutable receipt-chain verification
no audited adapter execution before its intent receipt is committed
no raw arguments, raw results, Bearer, or MCP session ID in receipts
no silent success when a result receipt cannot be committed
no automatic retry assumption after AUDIT_RESULT_UNAVAILABLE
no single-use definition without immutable intent-result audit
no public single-use prompt before deterministic schema/authority/target preflight
no single-use execution without its exact active LOCAL_ALLOW decision
no execution when the broker result request UUID differs from the planned approval UUID
no approval-plan authorization more than once
no queued, expired, duplicate, recently retired, resolved, cancelled, or stale approval UUID execution
no direct Allow action in notification surfaces
no approval review without FLAG_SECURE
no raw argument value in approval presentation
no pending approval after Gateway stop, foreground-service destruction, or authority-profile change
no current public consequential tool merely because the broker exists
```

## Acceptance criteria through M5d-1

Accessibility:

- service absent -> observe/action fail closed;
- protected text is redacted;
- traversal and queue stop at configured limits;
- stale revision and unknown ref are rejected;
- UI event invalidates existing refs;
- locator fingerprint mismatch is rejected;
- L1 cannot execute interactions;
- protected package/node is denied;
- submitted action invalidates the revision;
- global actions use an explicit allowlist;
- swipe coordinates and duration are bounded.

Apps:

- visible launcher listing does not require `QUERY_ALL_PACKAGES`;
- disabled, non-exported, malformed and duplicate launcher components are omitted;
- app list is bounded, deterministic and explicitly truncated;
- public results do not expose internal activity names;
- launch requires the exact current app-list revision and opaque ref;
- stale, expired, forged and cross-revision refs are rejected;
- the exact launcher component and package policy are revalidated immediately before launch;
- an accepted launch dispatch invalidates both app-list and Accessibility revisions;
- Android launch failure does not silently report success and allows only a bounded retry with the still-current ref;
- an accepted dispatch reports `confirmationRequired=true` and is not treated as proof that the target became foreground;
- real-device acceptance confirms foreground presentation separately and covers package visibility, multiple-launcher packages and OEM background-activity policy.

Notifications:

- listener absent or revoked -> connected status is false, list is unavailable, and no records are returned;
- post/remove/connect/disconnect/profile/runtime change replaces or clears the current snapshot;
- status fields and normalized error codes are bounded and contain no notification text;
- list is capped at 128, newest-first, deterministic, normalized, and explicitly count-bounded;
- raw notification keys, PendingIntents, action objects, arbitrary extras, and history never appear in MCP output or receipts;
- package content is sensitive by default and hard-sensitive authenticator/password-manager/banking/payment packages cannot be content-allowlisted;
- contextual OTP digits are redacted before publication;
- refs are observational only; the public catalog/server contains no notification action handler;
- real-device acceptance covers Notification Access grant/revocation, listener replacement/restart, update races, policy invalidation, and OEM delivery behavior.

Screens and local projection ownership:

- Android below API 30 or an absent Accessibility service returns a bounded unsupported/unavailable result when no valid local MediaProjection session is active;
- capture requires a current observed surface and local sensitive-surface policy approval;
- a valid active MediaProjection session is authoritative for that request, and its failure never falls back to Accessibility under a different snapshot;
- each projection frame consumes one five-second lease bound to generation, session, package, surface revision, and dimensions;
- a package/window/revision or projection-session change during capture discards and zeroes the frame;
- projection frame wait is capped at two seconds, row/pixel stride and buffer length are checked, and blank/transparent protected output fails closed;
- secure-window and uncertain screenshot failures fail closed;
- encoded PNG dimensions, pixels, size, MIME type, and SHA-256 are validated before publication;
- exactly one 15-second in-memory artifact is retained and old bytes are zeroed on replacement, expiry, or invalidation;
- the transient controller result copy is zeroed after MCP metadata serialization;
- `android.screen.capture` returns metadata only and `android.screen.read` remains absent;
- MediaProjection consent can be started only from the local non-exported UI, uses generation/request/session/deadline validation, and is revoked on denial, timeout, callback stop, explicit Stop, service loss, expiry, or process recovery;
- no MCP tool starts MediaProjection consent, issues a lease directly, or returns projection pixels.

Gateway:

- valid listener resolves only to `127.0.0.1`;
- missing/wrong/duplicate Bearer receives 401;
- invalid Host/Origin or a query-bearing/non-exact URI fails before MCP session creation;
- no permissive CORS response surface is installed;
- valid MCP initialize returns a bounded session ID;
- tools/list and tools/call succeed only inside that session;
- DELETE closes the session and stale use returns 404;
- payload above 1 MiB receives 413;
- ninth live session receives 429;
- malformed uninitialized requests do not leak permits;
- Stop closes all sessions;
- first listener-stop failure is retried; repeated failure retains `listenerOwned`, blocks restart/rotation, and remains visibly stoppable;
- cancellation during startup runs non-cancellable listener cleanup;
- app-level or dedicated-channel notification loss stops the listener, or terminates the app process if shutdown remains unconfirmed;
- APK service is non-exported and notification-visible;
- full Bearer reveal is temporary, `FLAG_SECURE`, Accessibility-hidden, and never copied automatically;
- tests contain no real device/user/app data.

Audit:

- an empty receipt directory verifies as ready;
- Gateway startup verifies the ledger before credential loading or listener creation;
- each initialized MCP session derives a stable bounded principal fingerprint without persisting its raw session ID;
- every audited tool writes an intent and a linked result receipt;
- successful, denied, failed and cancelled outcomes use explicit phases and codes;
- persisted receipts contain no raw tool text, raw result content, Bearer, or MCP session ID;
- concurrent appends produce one contiguous sequence and hash chain;
- appended bytes, receipt tampering, sequence gaps, unexpected entries and unsafe paths fail closed;
- an orphan temporary file does not authorize or replace a receipt and remains bounded;
- an intent append failure prevents operation invocation;
- a result append failure returns an explicit uncertain-outcome error and a later audited call still fails closed;
- audit status and recent-receipt diagnostics do not recursively create audit receipts;
- device testing records whether directory metadata durability is available rather than assuming it.

Approval:

- only trusted catalog definitions marked `single-use` enter the broker, and construction rejects single-use definitions without `intent-result` audit;
- future public single-use facades complete deterministic schema/authority/target preflight before presenting a request;
- an intent receipt containing the approval UUID is durable before the request is presented;
- local Allow executes the associated closure exactly once, a second plan authorization returns `APPROVAL_REPLAY`, and both receipts contain the same approval UUID;
- local Deny, timeout, queue overflow, duplicate ID, mismatched result ID and broker failure do not invoke the operation;
- only one request is active, queue order is FIFO, and queued requests cannot be resolved early;
- resolved, expired, cancelled, overflow, duplicate, and recently retired UUIDs cannot be replayed within the bounded retirement cache;
- cancellation removes the exact queued request without disturbing an unrelated active request;
- burst detection appears after the configured number of rapid requests;
- Gateway stop and service destruction deny every active/queued request before transport teardown;
- authority-profile changes cancel pending requests;
- approval notification contains no raw arguments and has no Allow action;
- in-app review shows trusted tool metadata, principal fingerprint, digest prefix, countdown and queue depth under `FLAG_SECURE`;
- Sovereign's own Accessibility adapter cannot interact with the approval surface;
- current public catalog has no `single-use` tool, so M4b does not expand executable authority;
- real-device acceptance verifies heads-up delivery, timeout, rotation/recreation behavior and OEM notification handling.

## Screenshot and notification threats

### Secure or secret-bearing screen capture

A screenshot may contain passwords, OTPs, financial data, or authentication secrets even when the Accessibility tree is redacted. Accessibility and MediaProjection capture both apply the same local sensitive-surface screenshot policy before frame production. Android secure-window, blank/transparent protected projection output, or uncertain screenshot failures are fail closed. The exact active package, window, and revision are checked before and after capture so a surface switch cannot silently relabel pixels.

### Screenshot persistence and replay

Raw screenshots are bounded, held only in process memory, replaced by the next capture, and zeroed on invalidation or expiry. Dimensions, pixel count, MIME type, encoded size, and SHA-256 are validated. Temporary projection row/bitmap/encoder buffers and rejected frames are cleared or released; the result copy used by MCP is zeroed after metadata serialization. Audit records contain only bounded result digests and metadata. `android.screen.capture` returns metadata and an opaque capture ID only; `android.screen.read` is absent from both the public catalog and server dispatch.

### Notification exfiltration and stale observations

Notification title/text can contain OTPs, private messages, account activity, and authentication prompts. Package content is treated as sensitive unless a local policy explicitly permits it, while authenticator, password-manager, banking, and payment classifications remain hard sensitive. Contextual OTP values are removed before publication. Source system keys remain in process memory only. Snapshot refs are observations, not capabilities: this checkpoint exposes no notification action tool.

### User-granted listener authority

`NotificationListenerService` is declared with Android's binding permission but cannot enable itself. The user must explicitly grant notification access in system settings. Listener disconnect, profile change, runtime invalidation, and post/remove refresh clear or replace the current snapshot.

### MCP surface exposure

The remote surface is intentionally asymmetric:

```text
android.screen.capture       registered, metadata only
android.screen.read          absent
android.surface.status       registered, bounded status only
android.notification.status  registered, bounded/read-only
android.notification.list    registered, redacted/read-only
notification actions         absent
```

The four registered surface tools use the existing authenticated loopback server, L1 policy, generated catalog, and immutable receipt middleware. Raw screenshot bytes, Android notification keys, `PendingIntent` objects, arbitrary extras, action objects, and reply inputs are not present in structured responses or receipts.

### Notification access controls

- access is enabled only by the Android device owner in system settings;
- the service is protected by `BIND_NOTIFICATION_LISTENER_SERVICE`;
- active records are capped at 128 and never persisted by the adapter;
- raw system notification keys, extras, actions, and PendingIntents are not returned to MCP clients or audit receipts;
- package policy is fail closed and hard-sensitive package classes cannot be content-allowlisted;
- contextual OTP values are redacted before publication;
- status/list are read-only and there is no Open, Reply, Dismiss, Clear, Delete, or arbitrary action handler;
- normalized listener error codes contain no raw notification content.

Local package overrides are bounded policy inputs, not implicit authorization to execute a notification action.

### Accessibility screenshot capture

When no local projection session is active, the fallback frame path uses Android 11+ `AccessibilityService.takeScreenshot`. Controls include:

- a connected Accessibility service and current observed surface are required;
- sensitive-surface policy is checked before capture;
- the exact package/window/revision is checked again after capture;
- secure-window and uncertain processing failures fail closed;
- hardware-buffer pixels are copied into bounded software memory and encoded as PNG;
- encoded output is limited to 8 MiB and 16,777,216 pixels;
- only one 15-second in-memory artifact is retained;
- replacement, expiry, and invalidation zero the previous byte array;
- no image bytes, text extraction, or base64 payload enters structured MCP output, approval text, or audit receipts.

### MediaProjection consent and frame ownership

The MediaProjection layer keeps consent local. Its non-exported Activity and foreground service bind consent to monotonic deadline, generation, request UUID, and projection-session UUID. Denial, malformed/stale metadata, timeout, callback stop, explicit Stop, service destruction, session expiry, fatal failure, or process recovery revokes ownership, closes the process-local frame source, and invalidates pending leases. Consent result Intents and projection tokens are never persisted, and no MCP tool can start the local consent surface.

A valid grant creates one `VirtualDisplay` with an `ImageReader` frame source for that token. Projection size/visibility callbacks update the source; captures are serialized, require one current five-second lease, and attach the frame surface only while waiting at most two seconds for that request. The surface is detached after a frame, failure, timeout, or close, so an idle projection session does not continuously produce frames. Native row padding and pixel stride are validated before bounded software copying. Black or transparent protected output is rejected, but blank-frame sampling never replaces local package policy or hard sensitive-surface denial. The exact projection source and foreground surface are rechecked before the PNG enters the same short-lived registry used by Accessibility capture. All mismatches zero the frame and publish nothing.
