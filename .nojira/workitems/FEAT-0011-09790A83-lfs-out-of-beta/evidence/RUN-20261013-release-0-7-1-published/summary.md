# RUN: 0.7.1 release published

**Claim:** Release 0.7.1 is published with the three assets; its main.js always passes `lfs` to the engine, has no "lfs-sync" beta entry, and keeps the "lfs-test" beta command.

**Commands / output:**
```
gh run watch 38463554019 --exit-status        # exit=0
draft=true  main.js 109338 / manifest.json 312 / styles.css 614
"version": "0.7.1"
main.js:2245  lfs: this.lfsOps()
id: "lfs-sync": 0 · id: "lfs-test": 2
gh release edit 0.7.1 --draft=false → draft=false https://github.com/kaleho/come-gither/releases/tag/0.7.1
```
