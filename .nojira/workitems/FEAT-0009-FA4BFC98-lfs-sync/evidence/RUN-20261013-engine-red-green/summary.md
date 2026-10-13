# RUN: red → green for the LFS sync engine

**Claim:** LFS push/pull/placeholder/change-detection behave per FEAT-0009 and DEC-0002 with LFS on, and are inactive with LFS off; 320 tests (after rebase onto #56), 100% coverage; build passes.


## RED (npx vitest run test/sync.test.ts, stubs only: types + config fields)
```
   × LFS (beta) > push > pushes a new file over the threshold as a pointer, with its .gitattributes line, in one commit 8ms
   × LFS (beta) > push > never re-uploads an unchanged LFS file, even after its mtime drifts 1ms
   × LFS (beta) > push > keeps an edited LFS file in LFS even under the threshold 1ms
   × LFS (beta) > push > skips a file whose upload fails, commits no pointer, and still pushes the others 1ms
   × LFS (beta) > push > skips a file over the LFS limit with a warning that names 2 GB 1ms
   × LFS (beta) > push > does not duplicate a .gitattributes line that is already there 1ms
   × LFS (beta) > push > appends after a .gitattributes with no trailing newline, keeping its bytes 1ms
   × LFS (beta) > push > refuses to push an edited LFS file while LFS is off 1ms
   × LFS (beta) > pull > turns a pointer into a placeholder with the real size, for binary and text extensions 1ms
   × LFS (beta) > pull > adopts an untracked local copy that matches the remote pointer 0ms
   × LFS (beta) > pull > never parks pointer text or text-merges on an LFS conflict 1ms
   × LFS (beta) > pull > tracks GitHub's new pointer for an LFS file deleted here 1ms
   × LFS (beta) > placeholders > fetchLazy downloads through LFS and keeps the entry an LFS file 4ms
   × LFS (beta) > placeholders > fetchLazy of an LFS placeholder fails clearly while LFS is off 2ms
   × LFS (beta) > placeholders > revert restores an edited LFS file from LFS, never as pointer text 1ms
   × LFS (beta) > placeholders > a push-side Keep of a deleted LFS file restores it as a placeholder 1ms
   × LFS (beta) > preview > classifies LFS changes the way sync then applies them 1ms
⎯⎯⎯⎯⎯⎯ Failed Tests 17 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: expected [] to deeply equal [ Array(1) ]
AssertionError: expected [] to have a length of 1 but got +0
AssertionError: expected undefined to be '377a23f52c6b357696238c3318f677a082dd3…' // Object.is equality
AssertionError: expected [] to deeply equal [ 'big.bin' ]
AssertionError: expected [ { path: 'huge.bin', action: 'new' } ] to deeply equal [ { path: 'huge.bin', …(2) } ]
AssertionError: expected '' to be '*.psd binary\n/big.bin filter=lfs dif…' // Object.is equality
AssertionError: expected '' to be '*.psd binary\n/big.bin filter=lfs dif…' // Object.is equality
AssertionError: expected [ Array(1) ] to deeply equal [ 'big.bin' ]
AssertionError: expected { upToDate: false, fetched: 2, …(6) } to match object { placeholders: 2, fetched: 1 }
AssertionError: expected +0 to be 1 // Object.is equality
AssertionError: expected { mtime: 7, size: 127 } to be null
AssertionError: expected { …(3) } to match object { …(2) }
AssertionError: expected Uint8Array[ 118, 101, 114, 115, …(24) ] to deeply equal Uint8Array[ 9, 9, 9, 9, 9, 9, 9, …(492) ]
AssertionError: promise resolved "'fetched'" instead of rejecting
AssertionError: expected [] to have a length of 1 but got +0
AssertionError: expected { …(5) } to match object { lazy: true, remoteSize: 20, …(1) }
AssertionError: expected [ { path: 'n.md', action: 'fetch' } ] to deeply equal [ { path: 'n.md', …(1) } ]
      Tests  17 failed | 159 passed (176)
```

## GREEN (npx vitest run --coverage; npm run build OK)
```
 Test Files  9 passed (9)
      Tests  298 passed (298)
All files  |     100 |      100 |     100 |     100 |                   
 state.ts  |     100 |      100 |     100 |     100 |                   
 sync.ts   |     100 |      100 |     100 |     100 |                   
```
