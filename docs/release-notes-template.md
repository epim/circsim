# Release notes template

Copy the block below into the draft release on GitHub, fill it in, and publish. The tag-triggered
CI job attaches the installers to a draft release and writes no notes, so every release needs this
step. Keep each section short; delete a section that has nothing in it, except Known issues.

For the "What's Changed" list, open the draft release, press "Generate release notes", and paste
the result under the heading below. `.github/release.yml` groups the pull requests by label, so a
PR that is missing a label lands in "Other changes". Label PRs before generating.

circsim is a validation tool, so the section that matters most is the one that says whether
results changed. A user who validated a board on the previous version needs to know if re-running
it can now give a different answer.

```markdown
## circsim vX.Y.Z

One or two sentences: what this release is for, in terms of what a user can now do or trust.

### Do my earlier results change?

State one of these plainly:

- No. No change to models, the deck generator, the solver settings, or the Board Critic checks.
- Yes. List each change that can move a simulated value or a Critic finding, with the part or
  check name and the direction of the change. Example: "SS54 Schottky forward drop now follows the
  datasheet curve; a board that used it will read a lower rail than on vX.Y.(Z-1)."

### Highlights

- User-visible additions, each with a link to its docs page on https://epim.github.io/circsim/.

### What's Changed

Paste the generated list here.

### Known issues

- Open problems a user is likely to hit, each linked to its issue. If there are none, say so.

### Install

Download the installer for your platform from the assets below: Windows `.exe`, macOS `.dmg` (one
per CPU architecture), Linux `.AppImage` or `.deb`. The installers are unsigned, so Windows
SmartScreen and macOS Gatekeeper will warn on first launch. The
[install guide](https://epim.github.io/circsim/start/install) walks through each.

circsim makes no network calls and does not check for updates. To upgrade, download the new
installer from this page.

**Full changelog**: https://github.com/epim/circsim/compare/vPREVIOUS...vX.Y.Z
```

## Checklist before publishing

- The version in `package.json` matches the tag.
- Every PR in the list carries a label from `.github/release.yml`.
- "Do my earlier results change?" has an answer, and it matches the PR list.
- The docs site version label in `website/docs/.vitepress/config.mts` is updated.
- All five installer assets are attached (the release job fails loudly if a leg is missing).
