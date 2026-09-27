## Summary

Describe the behavior change and why it belongs in Sovereign.

## Boundary review

Check every affected area and explain the invariant below.

- [ ] Workspace containment or path identity
- [ ] Permission level, native approval, elevation, or credentials
- [ ] Task ownership, principal, Agent identity, or session lease
- [ ] Message delivery, acknowledgement, expiry, or recipient identity
- [ ] Execution idempotency or unknown outcomes
- [ ] Gateway, Tunnel, proxy, or Guardian recovery
- [ ] Renderer, Runtime Host, updater, checkpoint, or fencing authority
- [ ] Persistence or compatibility schema
- [ ] None of the above

Invariant and failure behavior:

<!-- What must remain true? What must fail closed? -->

## Validation

Exact commit tested:

Environment:

```text
Windows:
Node.js:
pnpm:
Rust (if applicable):
Android/JDK (if applicable):
```

Commands and exit codes:

```text

```

- [ ] Added or updated deterministic tests for changed behavior
- [ ] Reran affected checks after the final source change
- [ ] Recorded skipped or unavailable checks
- [ ] Used synthetic fixtures and removed private data and credentials
- [ ] Updated the lockfile and third-party notices for dependency changes
- [ ] Updated documentation for user-visible behavior changes
- [ ] Reported security-sensitive details privately when appropriate

## Evidence level

- [ ] Source/type/unit/integration checks only
- [ ] Packaged candidate verified
- [ ] Installed candidate verified
- [ ] Candidate activated
- [ ] Running behavior observed in the target environment
- [ ] Physical desktop, network, UAC, or device acceptance performed

Do not select a stronger evidence level than the work actually established.

## Compatibility and limitations

Describe migration, protocol, operating-system, or backward-compatibility implications and any remaining limitations.
