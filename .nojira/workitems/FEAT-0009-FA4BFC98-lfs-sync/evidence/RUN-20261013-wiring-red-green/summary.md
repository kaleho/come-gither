# RUN: red → green for TASK-0015

**Claim:** beta-gated LFS wiring, manifest entry, settings/README text (TASK-0015) and LFS progress plumbing + text helpers (TASK-0017) behave as specified; 330 tests, 100% coverage; build passes. Shared run for both TASKs. main.ts notices untested until the iPad run.


## RED: npx vitest run (stubs in place)
```
   × BETA_FEATURES: LFS sync > lists LFS sync as a behavior change, never a ribbon command 5ms
   × progressBar > fills 10 cells in proportion, rounding down, clamped 5ms
   × progressText > names the file, the bytes done and total, and a bar 0ms
   × uploadText > shows the name, size, and m:ss elapsed for a single upload 0ms
   × uploadText > adds n of N when the push has several LFS uploads 0ms
   × LFS (beta) > progress plumbing > passes each LFS upload its path, 1-based index, and the push's LFS candidate count 9ms
   × LFS (beta) > progress plumbing > counts a failed upload as an attempt 1ms
   × LFS (beta) > progress plumbing > fetchLazy hands its progress callback to the LFS download 1ms
   × downloadLfsObject > reports progress at the start and after each range 7ms
   × downloadLfsObject > reports progress once more for a full 200 1ms
⎯⎯⎯⎯⎯⎯ Failed Tests 10 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: expected undefined to match object { Object (name) }
AssertionError: expected [] to deeply equal [ [ +0, 10 ], [ 4, 10 ], …(2) ]
AssertionError: expected [] to deeply equal [ [ +0, 10 ], [ 10, 10 ] ]
AssertionError: expected [ undefined, undefined ] to deeply equal [ { path: 'big.bin', …(2) }, …(1) ]
AssertionError: expected [ undefined ] to deeply equal [ { path: 'big.bin', index: 1, …(1) } ]
AssertionError: expected [] to deeply equal [ [ 500, 500 ] ]
AssertionError: expected '' to be '░░░░░░░░░░' // Object.is equality
AssertionError: expected '' to be 'Downloading FATHER_EN_E01.pdf: 48.0 M…' // Object.is equality
AssertionError: expected '' to be 'Uploading FATHER_EN_E01.pdf (114.5 MB…' // Object.is equality
AssertionError: expected '' to be 'Uploading a.pdf (114.5 MB)… 2:05 — 2 …' // Object.is equality
      Tests  10 failed | 320 passed (330)
```

## GREEN: npx vitest run --coverage
```
      Tests  330 passed (330)
All files  |     100 |      100 |     100 |     100 |                   
 beta.ts   |     100 |      100 |     100 |     100 |                   
 lfs.ts    |     100 |      100 |     100 |     100 |                   
 sync.ts   |     100 |      100 |     100 |     100 |                   
 wire.ts   |     100 |      100 |     100 |     100 |                   
```

## npm run build: exit 0
