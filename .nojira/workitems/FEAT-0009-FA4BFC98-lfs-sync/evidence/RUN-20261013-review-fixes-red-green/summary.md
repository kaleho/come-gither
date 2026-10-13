# RUN: red → green for the LFS review fixes

**Claim:** review findings #1, #1b, #3, #5, #6, #7 on PR #58 are fixed: 8 ported/new tests red on main e077c56, green after; 338 tests, 100% coverage; build passes. #2 and #4 deferred in FND-0002.


## RED (main e077c56 + ported tests)
```
   × blob cache integrity > reads each pushed file once 9ms
   × LFS (beta) > review fixes > a placeholder pulled with LFS off downloads through LFS once LFS is on, never as pointer text 4ms
   × LFS (beta) > review fixes > a pull with LFS off turns a changed pointer of an LFS file into an LFS placeholder, never pointer text 1ms
   × LFS (beta) > review fixes > keeps a UTF-8 BOM in .gitattributes (append-only bytes) 1ms
   × LFS (beta) > review fixes > keeps invalid UTF-8 bytes in .gitattributes 1ms
   × LFS (beta) > review fixes > appends with CRLF to a CRLF .gitattributes 1ms
   × LFS (beta) > review fixes > adopts a local LFS file edited to exactly the plain blob now on GitHub 2ms
   × LFS (beta) > review fixes > records the real size when a downloaded LFS file is deleted here and changed on GitHub 1ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: expected [ 'a.md', 'a.md', 'b.md', 'b.md' ] to deeply equal [ 'a.md', 'b.md' ]
AssertionError: expected Uint8Array[ 118, 101, 114, 115, …(24) ] to deeply equal Uint8Array[ 9, 9, 9, 9, 9, 9, 9, …(492) ]
AssertionError: expected 128 to be +0 // Object.is equality
AssertionError: expected Uint8Array[ 42, 46, 112, 115, …(-41) ] to deeply equal Uint8Array[ 239, 187, 191, 42, …(16) ]
AssertionError: expected [ 35, 32, 99, 97, 102, 239, 191 ] to deeply equal [ 35, 32, 99, 97, 102, 233, 10 ]
AssertionError: expected '*.psd binary\r\n/big.bin filter=lfs d…' to be '*.psd binary\r\n/big.bin filter=lfs d…' // Object.is equality
AssertionError: expected { upToDate: false, fetched: +0, …(6) } to match object { conflicts: +0, adopted: 1 }
AssertionError: expected { …(6) } to match object { lazy: true, remoteSize: 40 }
      Tests  8 failed | 180 passed (188)
```

## GREEN (after fixes)
```
      Tests  338 passed (338)
All files  |     100 |      100 |     100 |     100 |                   
 sync.ts   |     100 |      100 |     100 |     100 |                   
 ✓ test/sync.test.ts > blob cache integrity > reads each pushed file once
 ✓ test/sync.test.ts > LFS (beta) > review fixes > a placeholder pulled with LFS off downloads through LFS once LFS is on, never as pointer text
 ✓ test/sync.test.ts > LFS (beta) > review fixes > a pull with LFS off turns a changed pointer of an LFS file into an LFS placeholder, never pointer text
 ✓ test/sync.test.ts > LFS (beta) > review fixes > keeps a UTF-8 BOM in .gitattributes (append-only bytes)
 ✓ test/sync.test.ts > LFS (beta) > review fixes > keeps invalid UTF-8 bytes in .gitattributes
 ✓ test/sync.test.ts > LFS (beta) > review fixes > appends with CRLF to a CRLF .gitattributes
 ✓ test/sync.test.ts > LFS (beta) > review fixes > adopts a local LFS file edited to exactly the plain blob now on GitHub
 ✓ test/sync.test.ts > LFS (beta) > review fixes > records the real size when a downloaded LFS file is deleted here and changed on GitHub
npm run build: exit 0
```
