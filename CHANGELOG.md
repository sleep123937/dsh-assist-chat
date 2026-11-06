# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-11-06

### Added

- **Ctrl+Shift+B** (`Cmd+Shift+B` on macOS) — a configurable command that opens the side chat for the conversation on screen, or focuses the existing tab instead of opening a second copy. It ships a Desktop default binding and appears in the shortcut settings; on the Web build it claims the chord before the host's own right-sidebar shortcut.
- A marketplace icon: `assets/icon-180.png` (with `assets/icon-512.png` as the high-resolution source), referenced from `package.json.icon` and used as the storefront tile in awesome-dsh-plugin. `icon.svg` remains the vector source.
- A **Roadmap** section in both READMEs: the 0.2.0 directions (ask about a selection, bring the conclusion back to the main thread, several side chats per conversation, refresh the snapshot) and the 0.3.0+ directions (nested side chats, save a branch as a real conversation, choose model and permission inheritance). No dates are promised. The READMEs also document the new shortcut.

### Fixed

- The left session list's "expand N more" counter no longer includes hidden side-chat branches that fell into the collapsed tail, so the number matches what the list can actually reveal; an exhausted counter is suppressed instead of promising rows that never appear.

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
