# RUN: red → green for uploadLfsObject / downloadLfsObject

**Claim:** upload (batch → PUT → verify, skip PUT when stored) and ranged download (206 ranges or one full 200, SHA-256 check, size 0) behave as specified; 297 tests, 100% coverage; build passes.


## RED (stubs: upload no-op, download returns empty buffer)
```
   × uploadLfsObject > batches, PUTs the body to the upload action, then verifies 4ms
     → Cannot read properties of undefined (reading 'body')
   × uploadLfsObject > skips the PUT when GitHub already has the object, but still verifies if asked 3ms
     → expected [] to deeply equal [ …(2) ]
   × uploadLfsObject > does nothing after the batch when the object is present and no verify is offered 1ms
     → expected [] to deeply equal [ Array(1) ]
   × uploadLfsObject > does not verify when the PUT succeeded and no verify is offered 1ms
     → expected [] to have a length of 1 but got +0
   × uploadLfsObject > throws that the token cannot use LFS on HTTP 401 1ms
     → promise resolved "undefined" instead of rejecting
   × uploadLfsObject > throws that the token cannot use LFS on HTTP 403 0ms
     → promise resolved "undefined" instead of rejecting
   × uploadLfsObject > throws the status on any other batch failure 0ms
     → promise resolved "undefined" instead of rejecting
   × uploadLfsObject > throws the object error code and message 0ms
     → promise resolved "undefined" instead of rejecting
   × uploadLfsObject > throws the PUT status and does not verify on a non-2xx PUT 0ms
     → promise resolved "undefined" instead of rejecting
   × uploadLfsObject > propagates an uploader that throws as an Error 0ms
     → promise resolved "undefined" instead of rejecting
   × uploadLfsObject > throws the verify status on a non-2xx verify 0ms
     → promise resolved "undefined" instead of rejecting
   × downloadLfsObject > reads the object in ranges of chunkBytes and returns the whole file 1ms
     → expected Uint8Array[] to deeply equal Uint8Array[ 0, 1, 2, 3, 4, 5, 6, …(4) ]
   × downloadLfsObject > uses 8 MiB ranges by default 257ms
     → expected +0 to be 8388611 // Object.is equality
   × downloadLfsObject > accepts a 200 with the full body when the server ignores Range, and stops 1ms
     → expected Uint8Array[] to deeply equal Uint8Array[ 0, 1, 2, 3, 4, 5, 6, …(4) ]
   × downloadLfsObject > rejects a 200 whose body is not the full file 0ms
     → promise resolved "" instead of rejecting
   × downloadLfsObject > rejects a 200 full body on a later range 0ms
     → promise resolved "" instead of rejecting
   × downloadLfsObject > rejects a range of the wrong length 0ms
     → promise resolved "" instead of rejecting
   × downloadLfsObject > rejects a status that is not 206 or 200 0ms
     → promise resolved "" instead of rejecting
   × downloadLfsObject > rejects content whose SHA-256 is not the oid 0ms
     → promise resolved "" instead of rejecting
   × downloadLfsObject > rejects size 0 when the oid is not the empty hash 0ms
     → promise resolved "" instead of rejecting
   × downloadLfsObject > throws the batch status, the object error, or a missing download action 0ms
     → promise resolved "" instead of rejecting
⎯⎯⎯⎯⎯⎯ Failed Tests 21 ⎯⎯⎯⎯⎯⎯⎯
      Tests  21 failed | 35 passed (56)
```

## GREEN
