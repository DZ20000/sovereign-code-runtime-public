# Process output and incremental reads

Terminal commands, managed runs, and interactive terminal sessions retain a bounded UTF-8 output tail. When output exceeds the configured capacity, older bytes are evicted so that final errors and completion messages remain available. This is a bounded diagnostic view, not a complete log archive. A process's exit code and terminal state remain authoritative even when its retained text is incomplete.

## Retained ranges

Managed run snapshots store `outputRetention` in their existing `metadata` object:

```json
{
  "schemaVersion": "scr.output-retention/v1",
  "stdout": { "startOffset": 4096, "endOffset": 8192 },
  "stderr": { "startOffset": 0, "endOffset": 0 }
}
```

Each range describes the returned string in absolute bytes of the decoded UTF-8 stream. Its length equals the UTF-8 byte length of that string. These are not offsets into an original log file or arbitrary binary pipe: invalid input is decoded using replacement characters. A character split across input chunks remains pending until its remaining bytes arrive; finalization flushes an incomplete trailing sequence.

New `terminal.exec` results expose the same object as `outputRetention`. Interactive sessions expose `outputStartOffset` and `outputEndOffset`; the workbench marks truncated output explicitly. Existing ledger records without range metadata retain their original prefix-based interpretation and remain readable without a database migration.

## Following a run

`runs.follow` returns an opaque cursor. Reuse it only for the same run. Each stream delta includes `text`, absolute `startOffset` and `endOffset`, `retainedBytes`, `retainedStartOffset`, `skippedBytes`, and `hasMore`.

When a reader falls behind eviction, `skippedBytes` reports the gap and the next read begins at the earliest retained character boundary. The cursor never labels old retained bytes as new output merely because a same-sized buffer changed. Offsets beyond produced output, unsafe integers, and offsets inside a UTF-8 character are rejected. A byte budget too small for the next whole character fails explicitly instead of returning a cursor that cannot advance.

Change waiting uses produced end offsets as well as state and retained lengths. Consequently an already-full tail can still wake a waiting reader when new output arrives.

## Parsed output and safety

Git commands and runtime discovery probes keep their prefix-oriented capture contract. Their output feeds parsers, so replacing it with a diagnostic tail would silently change the input format or omit required initial records. Only human-facing terminal and validation capture paths opt into tail retention.

Output buffering does not sandbox executed commands, authorize a retry, or prove that a disconnected operation did not run. Never automatically repeat a consequential command solely because its result was lost. Separate source tests, isolated process tests, native desktop acceptance, and installed-version validation when reporting results.
