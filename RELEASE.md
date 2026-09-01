# Cutting a release

The pipeline has one manual step at the end. Do all five, in order.

1. **Bump the version** on a branch: `manifest.json`, `package.json`, and add a new entry to `versions.json` (current `minAppVersion`: 1.7.2). Open a PR.
2. **Merge on green.**
3. **Tag main** with the bare version — no `v` prefix:

   ```sh
   git switch main && git pull --ff-only
   git tag 0.5.0 && git push origin 0.5.0
   ```

4. **Wait for the Release workflow.** The tag push runs `release.yml`, which builds, attests provenance, and creates a **draft** release with `main.js`, `manifest.json`, and `styles.css` attached.
5. **Publish the draft by hand.** Check the three assets are on it, then:

   ```sh
   gh release edit 0.5.0 --draft=false
   ```

   The Obsidian community site serves updates from the latest *published* release. A forgotten step 5 means no user ever sees the version.
