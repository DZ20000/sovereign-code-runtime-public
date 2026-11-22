# Application restarts and upgrades

Changes to the native shell, preload, Node runtime, Host Guardian, or native agent require a controlled process restart. The supported restart path is the desktop launcher and installer; it uses the running application identity and the selected verified package.

## Inspect the target

```powershell
pnpm restart:dry-run
pnpm restart:portable:dry-run
```

The ordinary command keeps the running executable in the current Windows session, or selects the installed application when no shell is running. The portable command explicitly selects this checkout's recorded portable build. Multiple running shells or ambiguous installed locations require an explicit target.

## Restart intentionally

```powershell
pnpm restart
pnpm restart:portable
```

These commands stop running work. Coordinate any in-flight task or remote-session disruption before executing them. They do not provide an automatic task checkpoint, cross-process task resume, or transactional application rollback. The old standalone TypeScript restart journal and transaction prototype were never connected to these commands and have been removed.

The launcher asks the selected shell for intentional shutdown. Any bounded stop fallback is restricted to that instance's identified process tree. A portable candidate is verified against its package manifest before launch; its product version alone does not identify the source commit.

## Choose the update owner

- [Renderer hot updates](renderer-hot-updates.md) describes signed renderer installation, activation, readiness, and rollback in the Tauri host.
- [Runtime Host candidate updates](runtime-candidate-updates.md) describes the native candidate supervisor and its release-state commit boundary.
- [Development and packaging](development.md) describes NSIS installation, portable verification, shortcuts, and controlled restart commands.

A full application restart, renderer activation, and Runtime Host cutover have separate owners. Successful process launch alone does not prove Gateway, Tunnel, or remote-session readiness.
