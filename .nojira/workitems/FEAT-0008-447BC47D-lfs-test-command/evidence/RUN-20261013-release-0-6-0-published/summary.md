# RUN: 0.6.0 release published

**Claim:** Release 0.6.0 is published with the three assets, and its main.js contains the beta toggle, the ribbon icon, the lfs-test command, and the no-cache-bust LFS transport.

**Commands:**
```
gh run watch 38449149066 --exit-status        # exit=0
gh release view 0.6.0 --json isDraft,assets
gh release download 0.6.0 -p manifest.json -p main.js
grep -c '"lfs-test"' / 'Enable beta features' / 'addRibbonIcon' / 'bustCache: false' main.js
gh release edit 0.6.0 --draft=false
```

**Output (relevant):**
```
draft=true  main.js 96598 / manifest.json 312 / styles.css 614
"version": "0.6.0"
"lfs-test": 5 · Enable beta features: 2 · addRibbonIcon: 1 · bustCache: false: 2
draft=false https://github.com/kaleho/come-gither/releases/tag/0.6.0
```
