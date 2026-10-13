# RUN: red → green for the LFS module

**Claim:** src/lfs.ts (pointer, sha256, batch/verify/range client, runLfsTest) and GitHubClient createRef/deleteRef behave per FEAT-0008; 100% coverage; build passes. Red run had 30 runtime failures (assertions and TypeErrors on empty stubs), no import errors.


## RED (stubs in src/lfs.ts, no-op createRef/deleteRef) — npx vitest run test/lfs.test.ts test/github.test.ts
```
   × GitHubClient writes > createRef posts a full heads ref with the sha 3ms
   × GitHubClient writes > deleteRef deletes the branch ref and accepts an empty 204 0ms
   × GitHubClient writes > createRef surfaces 422 (ref exists) as a GitHubError 2ms
   × lfsPointer > writes the v1 pointer with LF endings and a trailing newline 6ms
   × sha256Hex > matches the known vector for 'abc' 1ms
   × gitattributesLine > anchors the exact path and marks it for LFS 0ms
   × gitattributesLine > escapes spaces as [[:space:]] and glob characters with a backslash 0ms
   × LfsClient > batch posts the LFS JSON body with Basic token auth and returns the actions 1ms
   × LfsClient > batch carries a per-object error 1ms
   × LfsClient > batch returns a failing status without throwing or parsing the body 2ms
   × LfsClient > verify posts oid and size with the action header only, and returns the status 0ms
   × LfsClient > readRange sends an inclusive Range header and returns status and bytes 0ms
   × httpUploader > PUTs the whole body with only the action header (no GitHub token) 1ms
   × runLfsTest > passes every step on the happy path, checkpointing before each one 4ms
   × runLfsTest > reports an already-stored object and skips the uploaders 1ms
   × runLfsTest > falls back to the next uploader when the first throws, and stops at the first 2xx 0ms
   × runLfsTest > fails the upload when every uploader fails and skips the dependent steps 0ms
   × runLfsTest > fails verify on a non-2xx status 0ms
   × runLfsTest > commits .gitattributes and the pointer on the test branch, parented on the base head 0ms
   × runLfsTest > replaces a test branch left over from a crashed run 0ms
   × runLfsTest > reports a pointer commit failure, still checks the download, and skips cleanup 0ms
   × runLfsTest > reads at most the first MiB and reports a match 50ms
   × runLfsTest > reports a mismatch and still cleans up 0ms
   × runLfsTest > reports a short range body as a mismatch 0ms
   × runLfsTest > fails the download check when no download action comes back, and still cleans up 0ms
   × runLfsTest > fails the download check on a non-200 download batch 0ms
   × runLfsTest > reports a cleanup failure 0ms
   × runLfsTest > explains a 401 batch as a token without LFS access and skips every later step 0ms
   × runLfsTest > fails the batch step on a per-object error 0ms
   × runLfsTest > skips everything after a failed hash 0ms
⎯⎯⎯⎯⎯⎯ Failed Tests 30 ⎯⎯⎯⎯⎯⎯⎯
      Tests  30 failed | 24 passed (54)
      2 AssertionError: expected +0 to be 200 // Object.is equality
      1 AssertionError: expected { status: +0, actions: {} } to deeply equal { status: 401, actions: {} }
      1 AssertionError: expected '' to be 'ba7816bf8f01cfea414140de5dae2223b0036…' // Object.is equality
      1 AssertionError: expected '' to be '/big.mp4 filter=lfs diff=lfs merge=lf…' // Object.is equality
      1 AssertionError: expected '' to be '/My[[:space:]]Videos/a[[:space:]]b\*c…' // Object.is equality
      1 AssertionError: expected '' to be 'version https://git-lfs.github.com/sp…' // Object.is equality
      1 AssertionError: expected [] to deeply equal [ 'hash', 'batch upload', …(5) ]
      1 AssertionError: expected undefined to be an instance of GitHubError
      1 AssertionError: expected undefined to be 'bytes=0-1048575' // Object.is equality
      1 AssertionError: expected undefined to deeply equal { step: 'cleanup', ok: false, …(1) }
      1 AssertionError: expected undefined to deeply equal { step: 'pointer commit', …(2) }
      1 AssertionError: expected undefined to deeply equal { step: 'upload', ok: true, …(1) }
      1 TypeError: Cannot read properties of undefined (reading 'body')
      1 TypeError: Cannot read properties of undefined (reading 'detail')
      1 TypeError: Cannot read properties of undefined (reading 'headers')
      1 TypeError: Cannot read properties of undefined (reading 'method')
     11 TypeError: Cannot read properties of undefined (reading 'ok')
      2 TypeError: Cannot read properties of undefined (reading 'url')
```

## GREEN — npx vitest run --coverage
```
 Test Files  8 passed (8)
      Tests  263 passed (263)
All files  |     100 |      100 |     100 |     100 |                   
