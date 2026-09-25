# Context-efficient tools

Sovereign provides two bounded tools for workflows that would otherwise repeat large reads: `runs.follow` and `workspace.context`.

## `runs.follow`

`runs.follow` returns only stdout and stderr bytes newer than an opaque cursor. The cursor is bound to one run and maintains independent byte offsets for both streams.

Example first read:

```json
{
  "runId": "<run-id>",
  "waitMs": 15000,
  "maxBytes": 65536
}
```

Continue with the returned cursor:

```json
{
  "runId": "<run-id>",
  "cursor": "<opaque-cursor>",
  "waitMs": 15000,
  "maxBytes": 65536
}
```

The result contains:

- a compact `scr.run/v1` summary;
- the next opaque cursor;
- `stdout` and `stderr` deltas with start/end offsets, retained byte count, and `hasMore`;
- `terminal`, indicating that the run can no longer produce output;
- `outputTruncated`, indicating that the run-wide retention limit discarded later output.

The cursor must be treated as opaque. A cursor for another run, an offset outside retained output, or an offset in the middle of a UTF-8 sequence is rejected. When no delta exists and the run is active, `waitMs` performs one bounded long poll before returning.

The current run collector preserves the retained prefix. Once `outputTruncated` is true, bytes beyond the run-wide retention limit cannot be recovered by following the cursor.

## `workspace.context`

`workspace.context` returns a compact repository map built from Git-aware file enumeration and bounded UTF-8 reads. It is intended for initial orientation and focused symbol/text discovery, not as a replacement for precise semantic tools.

A focused request:

```json
{
  "path": "packages/toolkit",
  "query": "ToolCatalog",
  "maxFiles": 80,
  "maxMatches": 20,
  "snippetLines": 1,
  "maxBytes": 65536,
  "includeUntracked": true
}
```

The response includes:

- current branch information;
- scoped dirty files with two-character Git status;
- matching repository-relative paths;
- matching lines with bounded surrounding snippets;
- candidate and scanned file counts;
- exact built-in exclusions;
- source-level truncation flags;
- `truncated`, `returnedBytes`, and `nextCursor`.

When `query` is omitted, the tool pages through matching repository paths rather than reading every file. When `query` is present, it scans a bounded number of searchable text files and returns bounded snippets.

`returnedBytes` is the exact UTF-8 byte length of the serialized response and never exceeds `maxBytes`. Dirty-file metadata is byte-bounded so it cannot consume the search page. Every non-null cursor advances to a new boundary; if the next path or match cannot fit on an otherwise empty page, the request is rejected with `INVALID_INPUT` instead of returning a cursor that would repeat forever.

When bounded Git output ends in a partial record, that incomplete path or status entry is discarded and the corresponding source truncation flag remains set. Workspace path guards are still applied to every content read; links, junction escapes, and non-regular entries are skipped rather than followed.

The built-in exclusions are:

```text
.git
.local-research
.research
.scr
.worktrees
artifacts
build
coverage
dist
node_modules
out
```

Git ignored files are excluded by `git ls-files --others --exclude-standard`. The built-in directory exclusions still apply even if generated or dependency files were force-added to Git.

The cursor is bound to the workspace, normalized scope, normalized query, untracked-file mode, and current candidate file list. Changing those inputs or changing the candidate file set invalidates the cursor. File contents are read at page time, so callers that require an immutable repository snapshot must also pin a Git revision or verify file hashes separately.

## Recommended sequence

For a typical repository task:

1. Call `workspace.context` with a scoped path and query.
2. Use `files.read_lines` for exact source ranges returned by context.
3. Use `code.symbols` or `code.symbol.find` when the optional semantic pack is enabled.
4. Use `git.diff` or `git.show` only for the relevant paths.
5. Start a fixed validation workflow and consume output with `runs.follow`.

This sequence keeps context bounded while preserving explicit cursor and truncation metadata.
