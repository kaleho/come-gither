# RUN: red → green for beta toggle, manifest, ribbon menu

**Claim:** ribbonMenuItems and betaFeatureText behave per FEAT-0006/0007; build passes; coverage 100%. main.ts UI (modal, settings rows, ribbon) is outside the gate and not hand-tested yet.


## RED: npx vitest run test/beta.test.ts (stubs return [] and "")
```
   × ribbonMenuItems > lists the core commands in order with an empty manifest 6ms
   × ribbonMenuItems > hides beta commands while beta is off 1ms
   × ribbonMenuItems > appends each beta feature that has a command while beta is on 1ms
   × betaFeatureText > joins what the feature does and what it writes 1ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  test/beta.test.ts > ribbonMenuItems > lists the core commands in order with an empty manifest
AssertionError: expected [] to deeply equal [ { title: 'Sync now', …(1) }, …(3) ]
 FAIL  test/beta.test.ts > ribbonMenuItems > hides beta commands while beta is off
AssertionError: expected [] to deeply equal [ { title: 'Sync now', …(1) }, …(3) ]
 FAIL  test/beta.test.ts > ribbonMenuItems > appends each beta feature that has a command while beta is on
AssertionError: expected [] to deeply equal [ { title: 'Sync now', …(1) }, …(4) ]
 FAIL  test/beta.test.ts > betaFeatureText > joins what the feature does and what it writes
AssertionError: expected '' to be 'Does A. Writes: A file under _a/.' // Object.is equality
      Tests  4 failed | 1 passed (5)
```

## GREEN: npx vitest run --coverage
```
 RUN  v2.1.9 /mnt/ssd/syncs/github/kaleho/come-gither-lanes/beta-and-ribbon
 ✓ test/beta.test.ts (5 tests) 4ms
 Test Files  8 passed (8)
      Tests  237 passed (237)
All files  |     100 |      100 |     100 |     100 |                   
 beta.ts   |     100 |      100 |     100 |     100 |                   
```

## GREEN: npm run build
```

> come-gither@0.5.3 build
> tsc -noEmit -skipLibCheck && node esbuild.config.mjs production

exit 0
```
