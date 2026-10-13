# RUN: 0.5.3 release published

**Claim:** Release 0.5.3 is published with the three assets, and its main.js contains the size label and the plan size.

**Commands:**
```
gh run watch 38442317640 --exit-status        # exit=0
gh release view 0.5.3 --json isDraft,assets
gh release download 0.5.3 -p manifest.json -p main.js
grep '"version"' manifest.json
grep -n -A2 'cls: "come-gither-preview-action",' main.js
grep -o 'skip-oversize.\{0,40\}' main.js
gh release edit 0.5.3 --draft=false
```

**Output (relevant):**
```
draft=true  main.js 79899 / manifest.json 312 / styles.css 614
"version": "0.5.3"
text: item.size === void 0 ? label : `${label} (${formatSize(item.size)})`
skip-oversize", size: stat.size });
draft=false https://github.com/kaleho/come-gither/releases/tag/0.5.3
```
