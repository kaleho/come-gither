# RUN: red → green for parseLfsPointer

**Claim:** parseLfsPointer reads v1 pointers (incl. extra keys) and rejects non-pointers, CRLF, uppercase hex, missing keys, other versions, and data ≥ 1024 bytes.

**Red** (`npx vitest run test/lfs.test.ts`, stub returning `{ oid: "", size: -1 }`):
```
FAIL parseLfsPointer > reads oid and size from a v1 pointer
FAIL parseLfsPointer > accepts extra keys between version and oid, as the spec allows
FAIL parseLfsPointer > rejects anything that is not a v1 pointer
FAIL parseLfsPointer > rejects data of 1024 bytes or more without decoding it
Tests  4 failed | 30 passed (34)
```

**Green** (`npm run build && npx vitest run --coverage`):
```
Tests  275 passed (275)
All files | 100 | 100 | 100 | 100
```
