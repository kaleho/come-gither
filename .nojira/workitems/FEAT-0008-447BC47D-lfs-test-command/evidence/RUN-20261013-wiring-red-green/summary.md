# RUN: red → green for the LFS test wiring (TASK-0010)

**Claim:** the lfs-test manifest entry, ribbon visibility, largestFirst and lfsTestSummary behave as specified; 271 tests, 100% coverage; build passes. main.ts flow (picker, confirm, uploaders, results modal, no-cache-bust transport) is outside the gate and untested in Obsidian until the 0.6.0 iPad run.

```
   × BETA_FEATURES > lists the LFS test command, shown in the ribbon menu only while beta is on 6ms
     → expected undefined to match object { …(2) }
   × largestFirst > drops empty items and sorts the rest by size, largest first, without mutating the input 6ms
     → expected [ 'a', 'empty', 'b', 'c' ] to deeply equal [ 'b', 'c', 'a' ]
   × lfsTestSummary > counts passed steps and marks each line 7ms
     → expected { passed: -1, total: -1, lines: [] } to deeply equal { Object (passed, total, ...) }
   × lfsTestSummary > handles no steps 1ms
     → expected { passed: -1, total: -1, lines: [] } to deeply equal { passed: +0, total: +0, lines: [] }
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯
      Tests  4 failed | 267 passed (271)
```

# GREEN (npx vitest run --coverage; npm run build exit 0)
```
      Tests  271 passed (271)
All files  |     100 |      100 |     100 |     100 |                   
 beta.ts   |     100 |      100 |     100 |     100 |                   
 lfs.ts    |     100 |      100 |     100 |     100 |                   
 wire.ts   |     100 |      100 |     100 |     100 |                   
npm run build exit 0
```
