# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-10-30

### Added

- Localized plugin metadata: `meta.title` and `meta.description` in `locale/en.json` and `locale/zh.json`. The DSH plugin page now shows **Side chat** / **辅助对话** with a real description, instead of the bare package name.
- Issue templates for bug reports and feature requests, so reports arrive with the version, steps and console output already filled in.
- A feedback section in both READMEs, pointing at the issue tracker and an email fallback.

### Changed

- Contact address is now **zousleep@163.com** (was a personal QQ address).
- `README.md` rewritten: what problem the plugin solves, a comparison against the alternatives, a walkthrough, a FAQ, and clearer install instructions for npm, GitHub and local checkouts.
- `RELEASING.md` replaced with a generic release guide (versioning, publish steps, marketplace listing) instead of the author-specific scratch notes it used to hold.
- Commit author is now `sleep123937 <zousleep@163.com>`.

### Removed

- `restart-dsh.ps1` — a local helper that hard-coded absolute paths on one machine. It never shipped on npm (the `files` allowlist excluded it) and is now also gone from the repository and its history.

### Fixed

- Plugin display name falling back to the package name in the DSH plugin list.
- Repository history rewritten so the removed helper script is not recoverable from earlier commits.

### Notes

- No runtime behaviour changed in this release: `client.js`, `index.js` and `cordis.patch.yml` are byte-identical to 0.1.0.

## [0.1.0] — 2026-10-30

### Added

- First public release.
- A right-dock side chat that forks the current conversation into its own Session, so follow-up questions never touch the main thread.
- The branch inherits the product Conversation surface: streaming, tool calls, Stop and the composer all behave exactly like the main conversation.
- Per-conversation branch identity, tab lifecycle bound to branch lifecycle, and catalog rows hidden while the tab is open.
