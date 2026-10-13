# RUN: 0.7.0 release published

**Claim:** Release 0.7.0 is published with the three assets, and its main.js contains beta LFS sync (manifest entry, upload/download, .gitattributes append, pointer parsing) and the upload progress text.

**Commands:**
```
gh run watch 38461146030 --exit-status        # exit=0
gh release view 0.7.0 --json isDraft,assets
gh release download 0.7.0 -p manifest.json -p main.js
grep -c <marker> main.js
gh release edit 0.7.0 --draft=false
```

**Output (relevant):**
```
draft=true  main.js 110232 / manifest.json 312 / styles.css 614
"version": "0.7.0"
Sync large files with Git LFS: 2 · uploadLfsObject: 2 · downloadLfsObject: 2 · appendGitattributes: 2 · "Uploading ": 1 · parseLfsPointer: 3
draft=false https://github.com/kaleho/come-gither/releases/tag/0.7.0
```

On-device verification (iPad push/pull of the 114.5 MiB file, web UI shows "Stored with Git LFS", progress notices) is pending the user's run; see FEAT-0009 Verification.
