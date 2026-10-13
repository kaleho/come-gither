# RUN: red → green for the oversize label size

**Claim:** The skip-oversize plan item carries the file size, and `formatSize` formats it like the download prompt.

**Red** (`npx vitest run`, with a `formatSize` stub returning ""):
```
FAIL test/sync.test.ts > preview: remaining classifications > classifies adopt, overwrite, keep-local, oversize and skips excluded paths
FAIL test/sync.test.ts > push protections > skips an oversize file without reading its content
FAIL test/wire.test.ts > formatSize > shows MB to one decimal at 1 MB or more   (expected '' to be '1.0 MB')
FAIL test/wire.test.ts > formatSize > shows whole KB below 1 MB, never 0 KB     (expected '' to be '1024 KB')
Tests  4 failed | 228 passed (232)
```

**Green** (`npm run build && npx vitest run --coverage`):
```
Tests  232 passed (232)
All files | 100 | 100 | 100 | 100
```

The preview label rendering is in main.ts, outside the coverage gate; it was not hand-tested in Obsidian.
