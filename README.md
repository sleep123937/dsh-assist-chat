# dsh-assist-chat

English | [中文](README.zh.md)

**Side chat for DeepSeek Harness.** Ask a follow-up without derailing what you are working on.

Opens a second conversation in the right dock that **already knows everything the main thread knows** — your current task, the error you just hit, the file you just edited. Ask your question there, get your answer, and the main thread stays exactly as it was.

## The problem it solves

You are mid-task. Something occurs to you that is not part of the task:

- "what does this error actually mean?"
- "would this approach even work?"
- "what is that function supposed to do?"

You have three options today, and two of them are bad:

| Option | Knows your context | Keeps your main thread clean |
| --- | --- | --- |
| Open a new conversation | ❌ You re-explain everything from scratch | ✅ |
| Just ask in the main thread | ✅ | ❌ The question and answer get written into the transcript you were about to hand off, and the agent gets derailed |
| **Side chat** | ✅ It forks the conversation | ✅ Nothing you say reaches the main thread |

A side chat is the third option done properly. It is the same idea as the side chat in [ZCode](https://github.com/zai-org/ZCode): a tab in the right dock, backed by a real, parallel conversation — not a modal, and it never takes over the main area.

## What it feels like

1. You are in a conversation with some history. A **Side chat** button sits in the session header.
2. Click it. The right dock opens with a tab called **Side chat**, containing a copy of that conversation — every message from before is already there.
3. Ask your question. It answers using the full context you already built up.
4. Close the tab. Your main conversation never noticed a thing.

The panel is not a reimplementation of chat: it mounts the product own Conversation surface, so streaming, markdown, tool cards, approvals, Stop and the composer behave exactly like the main conversation.

## Features

- **A branch, not a blank slate** — every opening forks the main conversation as it is right now, so no re-explaining.
- **Genuinely isolated** — its own Session, its own agent, its own transcript. Nothing leaks into the main thread.
- **Native chat surface** — messages, streaming, tool calls, code blocks, Stop, composer: all inherited, none redrawn.
- **One branch per conversation** — conversation A side chat never appears while you are looking at B.
- **Tab lifecycle is branch lifecycle** — one branch while the tab is open (survives tab switches and dock collapse), retired when you close the tab.
- **No clutter** — the branch is hidden from the left session list while alive, and archived once you close it.

## Install

```sh
# from npm (recommended)
dsh plugin --profile desktop add dsh-assist-chat

# or straight from the repository
dsh plugin --profile desktop add github:sleep123937/dsh-assist-chat

# or point at a local checkout
dsh plugin --profile desktop add link:/absolute/path/to/dsh-assist-chat
```

Use `--profile web` instead of `--profile desktop` if you run the browser build. **Restart DeepSeek Harness afterwards** — the button appears in the session header.

## FAQ

**Why can I not find it in the left session list?**
By design. The branch exists as a real Session (it has to, to have its own agent), but its catalog row is hidden while the tab is open, so your list stays clean. Close the tab and it is archived.

**Does it see what I say in the main thread afterwards?**
No. A fork is a snapshot: the branch knows the conversation up to the moment you opened it. If you want the newer context, close the tab and open a fresh one.

**Does anything I ask here pollute the main conversation?**
No. Separate Session, separate transcript. The main thread is byte-for-byte unchanged.

**Can I keep several open?**
Yes — the dock supports tabs and split panes. Each branch is tied to the conversation it was forked from.

**Why did my message disappear once?**
If a branch gets archived while its tab is still open, DSH rejects its model steps silently. This plugin only archives on tab close, and attempts to restore a branch that is somehow still archived. If you ever see it, reopen the tab.

## How it works

*This section is for people reading the source. You do not need it to use the plugin.*

Registered pieces:

| Piece | Registration |
| --- | --- |
| Tab type | `ctx.sidebarRightTabs.register({ id, kind: "assistchat", keepMounted: true, guide })` |
| Tab body | `ctx.slots.register({ name: "sidebar.right.pane.tab", key: <id>, children })` |
| Chat surface | `renderFactorySlot("conversation.content", { variant: "embedded", phase, hero }, { slots: { views: FixedChatView } })` |
| Entry point | `conversation.session.header.actions` — a list seat; `.corner` is single and already taken |

Branch lifecycle: resolve the conversation on screen (`uiWorkspace.mainReference.sessionId`) → `sessions.fork({ sessionId, increaseTitle: true })` → `sessions.retain(...)` → release and archive on unmount. The parent id rides the tab navigation params, so the dock keeps the branch bound to its own conversation.

### Two things that will bite you

**Never archive a branch that is still in use.** DSH ships an `archived-session-gate` that rejects every `agent/pre-step` of an archived Session. Messages are accepted into the queue and then silently vanish, with no error at all. Archiving is only safe *after* the tab closes.

**Which forces hiding to be presentation-only.** The catalog renders one row per Session carrying `data-row-key="session:<id>"`, so the plugin marks the rows it minted and hides them with `display: none`. The Session stays fully writable. Trade-offs: the "expand N more" counter still counts hidden rows, and the trick is tied to that row-key convention.

## Compatibility

- DeepSeek Harness `>= 0.2.0` (`engines.dsh`).
- Client plugin API only: no host-side code, no patched DSH files.
- Tested on 0.2.1-rc.3, desktop profile.

## Development

```sh
npm test        # loads client.js in a mocked host and asserts every seat and render
npm run check   # syntax only
```

`test/smoke.cjs` runs the shipped Client module in a `vm` sandbox with a mock React and a mock Cordis context. No GUI needed.

## Feedback

Bugs, ideas and "this does not work on my machine" are all welcome:

- [Report a bug](https://github.com/sleep123937/dsh-assist-chat/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/sleep123937/dsh-assist-chat/issues/new?template=feature_request.yml)
- [Browse existing issues](https://github.com/sleep123937/dsh-assist-chat/issues)

Prefer email? Write to **zousleep@163.com**.

## License

MIT