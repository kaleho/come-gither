# RUN: build and tests for the upload limit setting

**Claim:** The build passes and all tests pass at 100% coverage with `maxPushMB` wired to `maxPushBytes`.

**Commands:**
```
npm run build
npx vitest run --coverage
```

**Output (relevant):**
```
tsc -noEmit -skipLibCheck && node esbuild.config.mjs production   (no errors)
Test Files  7 passed (7)
     Tests  230 passed (230)
All files  |  100 |  100 |  100 |  100
```

main.ts is outside the coverage gate (needs the Obsidian runtime). The engine's push-limit skip is tested at test/sync.test.ts:315. Uploads above 30 MB are not yet hand-tested on iPad.
