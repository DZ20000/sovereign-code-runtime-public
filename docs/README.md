# Documentation

[简体中文](README.zh-CN.md) · [Project README](../README.md)

## Use and develop

| Goal | Start here |
| --- | --- |
| Install prerequisites, run from source, and choose validation | [Development and validation](development.md) |
| Understand process boundaries and the shared UI | [Architecture](architecture.md) |
| Configure remote access, startup, and recovery | [Remote host](remote-host.md), [control-plane failover](control-plane-failover.md) |
| Discover tools and optional capabilities | [Capability catalog](capability-catalog.md), [tool packs](tool-packs.md), [context tools](context-tools.md) |
| Inspect long-running output | [Process output](process-output.md) |
| Work with tasks and cross-task coordination | [Task hub](task-agent-hub.md), [task coordination](task-coordination.md) |
| Develop the Android preview | [Android README](../apps/android-agent/README.md), [Android architecture](android-agent-architecture.md) |
| Validate UI and performance | [Visual testing](visual-testing.md), [installed UI audit](installed-ui-audit.md), [performance budget](performance-budget.md) |

## Security and release

- [Threat model](threat-model.md) and [Android threat model](android-agent-threat-model.md)
- [Secure execution](secure-execution.md) and [Gateway session capacity](gateway-session-capacity.md)
- [Application restart updates](application-restart-updates.md)
- [Renderer hot updates](renderer-hot-updates.md) and [Runtime candidate updates](runtime-candidate-updates.md)
- [Signed updates](signed-update.md), [layered updates](layered-live-update.md), and [durable cutover recovery](durable-cutover-recovery.md)
- [Dependency security](dependency-security.md)

## Maintenance

- [Repository layout](repository-layout.md)
- [Generated-artifact inventory](generated-artifact-inventory.md)
- [Source-structure guard](source-structure-guard.md)
- [Session handoff](session-handoff.md)

Current behavior is defined by the source, package scripts, and current documentation—not by old local reports or private recovery notes.
