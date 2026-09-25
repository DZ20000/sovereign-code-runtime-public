# Sovereign Android Runtime

An independent Gradle project implementing Android observation and interaction through authenticated MCP. The Android app performs these operations through Android APIs; ADB is a development/device-setup tool, not the implementation of its MCP actions.

## Status of this checkout

Use [app/build.gradle.kts](app/build.gradle.kts) and the live `android.system.tool_manifest` to identify the version and tools being evaluated. This main-line source is the **0.2.0 developer preview**. An installed phone or a separate Android feature worktree can be newer; verify its APK version, source commit, and acceptance evidence before updating it. Do not infer installation or real-device acceptance from a successful source build.

| Area | Implemented here |
| --- | --- |
| Observation | Bounded, redacted Accessibility trees with opaque revision-bound refs; visible launcher-app discovery/current app; redacted current notifications. |
| Interaction | Locally selected L2 click, long-press, set-text, swipe, Back, Home, Recents, and revision/ref-bound app launch. L2 resets with the app process in this source version. |
| Screenshots | Accessibility screenshots on Android 11+ and locally consented MediaProjection frames. Public `android.screen.capture` returns metadata and an opaque capture ID only; `android.screen.read` is unregistered. |
| Connection | User-started foreground service, authenticated Streamable HTTP at an ephemeral `127.0.0.1` port, local credential protection, and bounded sessions. |
| Evidence and approval | Immutable intent/result receipts and a secure single-use approval broker. No current public tool consumes that broker. |

This checkout has no independent remote relay/tunnel, public notification actions/history, consequential send/delete/install/settings tools, Shizuku, Root, or arbitrary shell facade. These are implementation status statements, not a prohibition on future authorized development.

A successful local MCP call proves the Android execution path. It does not prove a direct cloud connection: a desktop agent can also use ADB to reach or initiate phone-local work. Test remote reachability separately with the intended bridge and device network. Real-device/OEM acceptance must be bound to the exact installed artifact; acceptance on another branch is not acceptance of this one.

## Build and validate

The project is outside the pnpm/TypeScript build graph. Configure a supported JDK (the architecture guide specifies JDK 21) and Android SDK with API 36; `JAVA_HOME` and `ANDROID_SDK_ROOT` must refer to your machine's installations. Machine-specific Java paths and `local.properties` are not committed.

From the repository root:

```powershell
Set-Location apps/android-agent
.\gradlew.bat testDebugUnitTest
```

Use `lintDebug` for Android lint and `assembleDebug` when an APK is needed. Run the checks relevant to the change; `clean` is not required for every edit. A candidate intended for device acceptance needs its applicable tests/lint/build plus separate installed-APK and device evidence. Inspect the installed version before any authorized `install -r` update so an older checkout does not overwrite a newer phone build.

## Local setup and connection

1. Install the intended APK, open the app, and enable **Sovereign UI Adapter** in Android Accessibility settings. The app opens the settings page but cannot grant the permission itself.
2. For notification observation, explicitly enable **Sovereign Notification Adapter** in Notification Access. Keep app notifications and the **Local MCP gateway** channel enabled for gateway operation. The separate **Local approvals** channel is for the broker's local alerts.
3. Select L1 Observe or intentionally select L2 Interaction, then press **Start gateway**. Startup verifies the receipt chain before listening.
4. Use **Reveal config** only for a trusted same-device MCP client. The reveal lasts 30 seconds, excludes clipboard transfer and Accessibility semantics, and uses `FLAG_SECURE`.
5. Stop through the app or foreground notification when finished. Unconfirmed listener shutdown retains ownership and prevents restart/credential rotation; unresolved service teardown fails closed.

The endpoint has this form, with the actual port supplied by the app:

```text
http://127.0.0.1:<port>/mcp
```

Every GET/POST/DELETE requires Bearer authentication and a valid loopback Host. MCP requests use `Accept: application/json, text/event-stream`. Native clients omit Origin; when present it must be one validated HTTP(S) loopback origin. Authentication cannot be disabled, and permissive browser CORS is not provided.

Use MCP `tools/list` or `android.system.tool_manifest` for the current catalog. Obtain fresh observation revisions before UI actions and a current app-list revision/ref before app launch. Launch dispatch is not foreground confirmation: follow it with `android.app.current` or `android.ui.observe`.

## Boundaries to preserve

- Accessibility, Notification Access, and MediaProjection consent belong to Android's user-controlled permission flow. No silent secure-settings change or ADB permission bypass is part of this app.
- Password, unverified, denied, SystemUI/permission, and Sovereign approval/credential surfaces remain protected. Notification content is sensitive by default, with hard-sensitive categories and contextual OTPs redacted. No notification ref executes an Android action.
- The gateway is loopback-only with mandatory Bearer, Host/Origin validation, body/session bounds, and visible foreground ownership. Never expose the listener publicly as an onboarding shortcut.
- Sensitive credentials use Android Keystore protection. Receipts and approval presentations contain bounded metadata/digests, not raw arguments, text input, screenshots, credentials, or session IDs.
- An immutable intent precedes audited execution. If a result receipt fails after an action, treat the outcome as uncertain and observe before retrying.
- Single-use approval remains local and one-shot, with no direct Allow action in notifications. Future consequential facades need deterministic policy preflight and a reviewed trusted approval boundary before registration.
- Screenshot producers revalidate surface identity, honor secure-window denial, and clear short-lived buffers. An active MediaProjection failure cannot silently switch to Accessibility capture.

## Implementation reference

Load the relevant section rather than treating the whole document set as a mandatory checklist:

- [Architecture and protocol contracts](../../docs/android-agent-architecture.md): module map, tool schemas, lifecycle, receipt/approval limits, screenshot and notification implementation.
- [Threat model](../../docs/android-agent-threat-model.md): security assumptions, protected surfaces, and release boundaries.
- [Upstream review](../../docs/research/android-agent-upstream-review.md): clean-room implementation research.
- [Repository development](../../docs/development.md) and [release/artifact entry](../../releases/README.md): distinguish source, candidate, installed, and verified states.
