# RUN: 0.5.2 release published

**Claim:** Release 0.5.2 is published with the three assets, and its main.js contains the upload limit setting.

**Commands:**
```
gh run watch 37808207893 --exit-status        # exit=0
gh release view 0.5.2 --json isDraft,assets
gh release download 0.5.2 -p manifest.json -p main.js
grep '"version"' manifest.json; grep -c maxPushMB main.js
gh release edit 0.5.2 --draft=false
```

**Output (relevant):**
```
draft=true  main.js 79722 / manifest.json 312 / styles.css 614
"version": "0.5.2"
6
draft=false https://github.com/kaleho/come-gither/releases/tag/0.5.2
```
