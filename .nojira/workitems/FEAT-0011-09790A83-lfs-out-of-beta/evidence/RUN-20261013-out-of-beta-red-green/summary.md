# RUN: red → green for LFS sync out of beta

**Claim:** "Sync large files with Git LFS" is no longer in the beta manifest (only "Test large file support" remains); the engine always gets `lfs`; 338 tests, 100% coverage; build passes.

**Red** (`npx vitest run test/beta.test.ts`):
```
FAIL test/beta.test.ts > BETA_FEATURES: LFS sync > is out of beta: only the LFS test command stays listed
AssertionError: expected [ 'lfs-test', 'lfs-sync' ] to deeply equal [ 'lfs-test' ]
Tests  1 failed | 5 passed (6)
```

**Green** (`npm run build && npx vitest run --coverage`):
```
Tests  338 passed (338)
All files | 100 | 100 | 100 | 100
```
The always-on `lfs: this.lfsOps()` in main.ts is outside the coverage gate; the engine's LFS behavior is covered by the FEAT-0009 tests.
