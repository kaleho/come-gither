---
id: RUN-20261028-osv-clean-build-green
task: TASK-0021-C88051E5
created: '2026-10-28T12:58:21+00:00'
updated: '2026-10-28T12:58:21+00:00'
branches:
- deps/osv-bump
external: {}
---

# osv-clean-build-green

## Command

```
osv-scanner scan source --offline-vulnerabilities -L package-lock.json
rm -rf node_modules && npm ci && npm run build && npm run coverage
```

## Output

Before (origin/main 4bdbf8c):
```
Total 10 packages affected by 24 known vulnerabilities (3 Critical, 6 High, 14 Medium, 1 Low, 0 Unknown)
Tests  338 passed (338)
All files | 100 | 100 | 100 | 100
```

After (deps/osv-bump):
```
No issues found            (osv-scanner exit 0)
Tests  341 passed (341)
Statements 100% (1046/1046)  Branches 100% (730/730)  Functions 100% (172/172)  Lines 100% (893/893)
```

## Claim

The bumps clear every OSV finding in package-lock.json while build, tests and the 100% coverage gate stay green.
