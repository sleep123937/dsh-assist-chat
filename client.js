// Assist chat — Client half.
//
// A right-dock seat that opens a *separate* Session: the side conversation has
// its own transcript, its own agent and its own context, so asking it something
// never disturbs the main thread. The panel reuses the product's own
// Conversation surface ("conversation.content") instead of redrawing a chat, so
// markdown, tool calls, approvals and streaming all behave exactly like the main
// conversation.
//
// Two product surfaces are patched from the outside, both through conventions
// the product keeps stable:
//   1. The left catalog renders one row per Session carrying
//      data-row-key="session:<id>" and a "show more" button carrying
//      data-row-key="overflow:<groupKey>". Branch rows are hidden with
//      display:none (an archived Session cannot run a model step, so hiding must
//      stay presentation-only), and the "show more" count is corrected so the
//      hidden rows are not promised to the user.
//   2. Ctrl+Shift+B (Cmd+Shift+B on macOS) opens or focuses the side chat. The
//      product registers commands through the shortcuts service, so the Desktop
//      shell gets a real, configurable command. The Web build already binds the
//      same chord to "collapse the right sidebar", therefore a capture-phase
//      window listener consumes the chord before the host's bubble-phase
//      dispatcher runs.
window.__ModuleLoader__.load({
  id: 'dsh-assist-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const Fragment = React.Fragment;

    /* ------------------------------------------------------------------ *
     * Constants
     * ------------------------------------------------------------------ */

    /** Localization namespace, also used by the Client locale service. */
    const NS = 'dsh-assist-chat';
    /** Implementation id: loader id, tab-type registry key and style tag owner. */
    const IMPL_ID = 'dsh-assist-chat';
    /** Right-dock page kind. Single-instance on purpose: re-opening reveals the existing tab. */
    const KIND = 'assistchat';
    /** Key of the right-dock tab body slot owned by this plugin. */
    const TAB_SLOT = 'sidebar.right.pane.tab';
    /** Conversation slot mounted inside the tab body. */
    const CONV_SLOT = 'sidebar.assist.conversation';
    /** Session-header seat that carries the entry button. */
    const HEADER_SLOT = 'conversation.session.header.actions';

    /** Verbose tracing switch; warnings are always reported. */
    const DEBUG = false;

    /**
     * Global command that opens or focuses the side chat.
     * On Desktop the shell binds primary+shift+KeyB (Ctrl+Shift+B / Cmd+Shift+B).
     * Defaults are declared for desktop profiles only: the Web build already binds
     * the same chord to sidebar.right.toggle and shortcuts.register rejects
     * overlapping defaults across every profile, so a Web default would throw.
     */
    const SHORTCUT_ID = 'dsh-assist-chat.open';
    const SHORTCUT_KEY_CODE = 'KeyB';
    const SHORTCUT_MODIFIERS = ['primary', 'shift'];
    const SHORTCUT_REGIONS = ['page', 'editable', 'terminal'];
    /** Debounce between the native bridge command and the DOM fallback for one press. */
    const SHORTCUT_DEBOUNCE_MS = 250;
    function shortcutBinding() {
      return { code: SHORTCUT_KEY_CODE, modifiers: SHORTCUT_MODIFIERS.slice() };
    }
    const SHORTCUT_DEFAULTS = {
      'desktop:macos': shortcutBinding(),
      'desktop:windows': shortcutBinding(),
      'desktop:linux': shortcutBinding()
    };

    /** Left-catalog conventions (see dsh-client-ui-workspace: rows / overflow button). */
    const ROW_KEY_PREFIX = 'session:';
    const OVERFLOW_KEY_PREFIX = 'overflow:';
    const ROW_SELECTOR = '[data-row-key^="' + ROW_KEY_PREFIX + '"]';
    const OVERFLOW_SELECTOR = '[data-row-key^="' + OVERFLOW_KEY_PREFIX + '"]';
    /** Attribute and rule that hide our branch rows without archiving them. */
    const HIDE_ATTR = 'data-assist-hidden';
    /** Attribute that suppresses a counter whose remaining rows are all ours. */
    const OVERFLOW_EMPTY_ATTR = 'data-assist-overflow-empty';
    const HIDE_STYLE_TEXT = '[' + HIDE_ATTR + ']{display:none !important}[' + OVERFLOW_EMPTY_ATTR + ']{display:none !important}';

    /* ------------------------------------------------------------------ *
     * Locale
     * ------------------------------------------------------------------ */

    const ZH = {
      'tab.title': '辅助对话',
      'guide.title': '辅助对话',
      'guide.description': '开一个与主对话隔离的旁支会话，随时追问而不打断主线',
      'header.button': '辅助对话',
      'header.buttonTitle': '在右侧栏开启辅助对话',
      'shortcut.open': '打开辅助对话',
      'shortcut.noSession': '当前没有可用的主对话',
      'status.creating': '正在准备辅助对话…',
      'status.error': '无法开启辅助对话',
      'retry': '重试'
    };
    const EN = {
      'tab.title': 'Side chat',
      'guide.title': 'Side chat',
      'guide.description': 'Open a side conversation isolated from the main thread',
      'header.button': 'Side chat',
      'header.buttonTitle': 'Open side chat in the right sidebar',
      'shortcut.open': 'Open side chat',
      'shortcut.noSession': 'No main conversation is available',
      'status.creating': 'Preparing side chat…',
      'status.error': 'Could not open side chat',
      'retry': 'Retry'
    };

    let rootCtx = null;
    let localeSvc = null;
    let registryState = null;

    /**
     * Translate one of our keys, preferring the registered Client locale service
     * and falling back to the bundled tables so the plugin never shows a raw key.
     * @param key - message key.
     * @param vars - interpolation values for name placeholders.
     * @returns the localized string.
     */
    function t(key, vars) {
      let value;
      try {
        if (localeSvc && typeof localeSvc.t === 'function') value = localeSvc.t(NS, key, vars);
      } catch (e) {}
      if (value === undefined || value === null) value = ZH[key] || EN[key] || key;
      if (vars) {
        value = String(value).replace(/\{(\w+)\}/g, function (m, k) {
          return vars[k] === undefined ? m : String(vars[k]);
        });
      }
      return String(value);
    }

    /* ------------------------------------------------------------------ *
     * Logging helpers
     * ------------------------------------------------------------------ */

    /** Debug-only trace; never throws. */
    function log() {
      if (!DEBUG) return;
      try { console.log.apply(console, ['[assist-chat]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    /** Warning channel for degraded-but-recoverable paths; never throws. */
    function warn() {
      try { console.warn.apply(console, ['[assist-chat]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    /** Human-readable message for a thrown value. */
    function errorMessage(error) {
      if (error === undefined || error === null) return 'unknown error';
      return String((error && error.message) || error);
    }

    /* ------------------------------------------------------------------ *
     * Session plumbing
     * ------------------------------------------------------------------ */

    /**
     * Branch Session ids that must not show up in the left catalog. Hidden at the
     * DOM level rather than archived: an archived Session cannot run a model
     * step, so hiding through data would silently make the side chat read-only.
     */
    const hiddenBranchIds = new Set();

    // Lifecycle of a branch is the lifecycle of its tab, deliberately:
    //   open the seat  -> fork the main conversation *as it is right now*
    //   keep it open   -> the same branch (keepMounted keeps it mounted)
    //   close the tab  -> retire that branch (archive it, so the catalog stays clean)
    // Caching per parent across openings would serve a stale snapshot forever,
    // which is exactly what a side chat must not do.

    /**
     * Resolve a Cordis service, tolerating a disposed or partially built context.
     * @param name - service name.
     * @returns the service, or undefined.
     */
    function getService(name) {
      try { return rootCtx ? rootCtx.get(name) : undefined; } catch (e) { return undefined; }
    }

    /** The Session catalog service, or null. */
    function sessionsService() {
      return getService('sessions') || null;
    }

    /**
     * Best-effort working directory for a fresh Session when no Workspace claims
     * the current conversation. Falls back to the most recently updated Session.
     * @param sessions - Session catalog service.
     * @returns a directory path, or undefined.
     */
    function pickCwd(sessions) {
      try {
        const snapshot = sessions.list.getSnapshot();
        const ids = (snapshot && snapshot.ids) || [];
        let best;
        for (let i = 0; i < ids.length; i += 1) {
          const row = snapshot.byId[ids[i]];
          if (!row || !row.cwd) continue;
          if (!best || (row.updatedAt || 0) > (best.updatedAt || 0)) best = row;
        }
        return best ? best.cwd : undefined;
      } catch (e) {
        return undefined;
      }
    }

    /**
     * The Workspace a side conversation should be filed under: the one holding
     * the main conversation, else the most recently touched one.
     * @returns a workspace id, or undefined.
     */
    function pickWorkspaceId() {
      try {
        const uiWorkspace = getService('uiWorkspace');
        if (!uiWorkspace) return undefined;
        const list = uiWorkspace.workspaces && uiWorkspace.workspaces.list;
        const items = (list && list.getSnapshot && list.getSnapshot().items) || [];
        if (!items.length) return undefined;
        const mainReference = uiWorkspace.mainReference;
        const currentId = mainReference && mainReference.sessionId;
        if (currentId) {
          const holder = items.find(function (item) {
            return item && item.sessionIds && item.sessionIds.indexOf(currentId) >= 0;
          });
          if (holder) return holder.workspaceId;
        }
        const sessions = sessionsService();
        const snapshot = sessions && sessions.list.getSnapshot();
        const byId = (snapshot && snapshot.byId) || {};
        let bestId;
        let bestAt = -1;
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (!item || !item.workspaceId) continue;
          const ids = item.sessionIds || [];
          let latest = 0;
          for (let j = 0; j < ids.length; j += 1) {
            const row = byId[ids[j]];
            if (row && (row.updatedAt || 0) > latest) latest = row.updatedAt || 0;
          }
          if (latest > bestAt) { bestAt = latest; bestId = item.workspaceId; }
        }
        return bestId || items[0].workspaceId;
      } catch (e) {
        return undefined;
      }
    }

    /**
     * An archived Session cannot run a model step: DSH's archived-session gate
     * rejects every pre-step. Earlier builds archived side conversations to keep
     * the catalog clean, which silently ate every message, so restore any branch
     * that is still archived before it is used.
     * @param sessionId - branch Session id.
     */
    function ensureWritable(sessionId) {
      try {
        const uiWorkspace = getService('uiWorkspace');
        if (!uiWorkspace || typeof uiWorkspace.unarchiveSession !== 'function') return;
        const archived = uiWorkspace.workspaces
          && uiWorkspace.workspaces.list.getSnapshot().archivedSessionIds;
        if (!archived || archived.indexOf(sessionId) < 0) return;
        const pending = uiWorkspace.unarchiveSession(sessionId);
        if (pending && typeof pending.catch === 'function') pending.catch(function (error) {
          warn('unarchive side session failed', error);
        });
      } catch (e) {
        warn('unarchive check failed', e);
      }
    }

    /* ------------------------------------------------------------------ *
     * Left-catalog presentation: hide branches and fix the "show more" count
     * ------------------------------------------------------------------ */

    /** Session id carried by a catalog row, or undefined when the key is foreign. */
    function rowSessionId(row) {
      try {
        const key = (row && typeof row.getAttribute === 'function' && row.getAttribute('data-row-key')) || '';
        return key.indexOf(ROW_KEY_PREFIX) === 0 ? key.slice(ROW_KEY_PREFIX.length) : undefined;
      } catch (e) {
        return undefined;
      }
    }

    /** Group key carried by the catalog's "show more" button, or undefined. */
    function overflowGroupKey(button) {
      try {
        const key = (button && typeof button.getAttribute === 'function' && button.getAttribute('data-row-key')) || '';
        return key.indexOf(OVERFLOW_KEY_PREFIX) === 0 ? key.slice(OVERFLOW_KEY_PREFIX.length) : undefined;
      } catch (e) {
        return undefined;
      }
    }

    /**
     * A consistent read of the two stores that describe the catalog: the Session
     * snapshot (what a row id means) and the Workspace list (which group a
     * Session belongs to). Returns undefined when either is unavailable, which
     * makes the caller fall back to a DOM-only correction.
     */
    function catalogSnapshot() {
      try {
        const sessions = sessionsService();
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return undefined;
        const list = sessions.list.getSnapshot();
        if (!list || !list.byId) return undefined;
        const uiWorkspace = getService('uiWorkspace');
        const workspaceList = uiWorkspace && uiWorkspace.workspaces && uiWorkspace.workspaces.list;
        if (!workspaceList || typeof workspaceList.getSnapshot !== 'function') return undefined;
        const state = workspaceList.getSnapshot();
        if (!state || !Array.isArray(state.items)) return undefined;
        const archivedSessionIds = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : [];
        return { list: list, items: state.items, archived: archivedSessionIds };
      } catch (e) {
        return undefined;
      }
    }

    /**
     * Browser group of a Session: its Workspace id, or '' for the Ungrouped
     * bucket (the key the workspace browser itself uses).
     * @param items - workspaces snapshot items.
     * @param sessionId - Session id.
     * @returns the group key.
     */
    function owningGroupKey(items, sessionId) {
      try {
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (!item || !item.sessionIds) continue;
          if (item.sessionIds.indexOf(sessionId) >= 0) return item.workspaceId;
        }
      } catch (e) {}
      return '';
    }

    /**
     * Hidden branches the catalog could only show in a collapsed tail: the total
     * hidden branches per group. Subtracting the rendered hidden rows from this
     * yields the ones that inflate the counter.
     * @param snapshot - catalogSnapshot() result.
     * @returns group key -> hidden branch count.
     */
    function hiddenBranchTotals(snapshot) {
      const totals = new Map();
      if (!snapshot) return totals;
      hiddenBranchIds.forEach(function (sessionId) {
        const row = snapshot.list.byId && snapshot.list.byId[sessionId];
        if (!row || row.blank === true) return;
        if (snapshot.archived.indexOf(sessionId) >= 0) return;
        const key = owningGroupKey(snapshot.items, sessionId);
        totals.set(key, (totals.get(key) || 0) + 1);
      });
      return totals;
    }

    /**
     * Hidden row elements currently rendered, counted per browser group.
     * @param hiddenRows - row elements currently marked hidden.
     * @param snapshot - catalogSnapshot() result.
     * @returns group key -> rendered hidden row count.
     */
    function renderedHiddenTotals(hiddenRows, snapshot) {
      const totals = new Map();
      for (let i = 0; i < hiddenRows.length; i += 1) {
        const sessionId = rowSessionId(hiddenRows[i]);
        if (!sessionId) continue;
        const key = owningGroupKey(snapshot.items, sessionId);
        totals.set(key, (totals.get(key) || 0) + 1);
      }
      return totals;
    }

    /**
     * DOM-only fallback used when the Session/Workspace stores are unavailable
     * (for example inside a unit-test mock): count hidden rows belonging to the
     * button's own group container.
     * @param button - "show more" button.
     * @param hiddenRows - row elements currently marked hidden.
     * @returns hidden row count for that container.
     */
    function containerHiddenCount(button, hiddenRows) {
      let container = null;
      try { container = button && button.parentElement ? button.parentElement : null; } catch (e) { container = null; }
      if (!container) return 0;
      let count = 0;
      for (let i = 0; i < hiddenRows.length; i += 1) {
        try {
          let node = hiddenRows[i].parentElement || null;
          while (node && node !== container) node = node.parentElement || null;
          if (node === container) count += 1;
        } catch (e) {}
      }
      return count;
    }

    /** Counter state store; WeakMap when available so re-rendered buttons restart clean. */
    const counterStates = typeof WeakMap === 'function' ? new WeakMap() : null;

    /** Read the counter patch bookkeeping for one button. */
    function readCounterState(button) {
      if (counterStates) return counterStates.get(button);
      return button && button.__assistCounterState;
    }

    /** Record the counter patch bookkeeping for one button. */
    function writeCounterState(button, state) {
      if (counterStates) { counterStates.set(button, state); return; }
      try { button.__assistCounterState = state; } catch (e) {}
    }

    /** Replace the button text without letting a failure escape the observer. */
    function setCounterText(button, text) {
      try { button.textContent = text; } catch (e) { warn('catalog counter patch failed', e); }
    }

    /** Hide the "show more" button while every row it would reveal is ours. */
    function markOverflowEmpty(button, empty) {
      try {
        if (empty) button.setAttribute(OVERFLOW_EMPTY_ATTR, '1');
        else if (typeof button.hasAttribute === 'function' && button.hasAttribute(OVERFLOW_EMPTY_ATTR)) button.removeAttribute(OVERFLOW_EMPTY_ATTR);
      } catch (e) {}
    }

    /**
     * Rewrite one "show more" label by subtracting hidden rows. Idempotent: the
     * product may re-render the original text at any time, so the base label is
     * remembered per button and re-derived only when the DOM text is not the one
     * we wrote last.
     * @param button - "show more" button.
     * @param hidden - hidden rows the label must not count.
     */
    function patchOverflowCounter(button, hidden) {
      let current = '';
      try { current = typeof button.textContent === 'string' ? button.textContent : String(button.textContent || ''); } catch (e) { return; }
      const state = readCounterState(button);
      const base = state && current === state.shown ? state.base : current;
      const match = /\d+/.exec(base);
      if (!match) {
        // Expanded ("show less") or a locale without a number: leave it alone.
        if (current !== base) setCounterText(button, base);
        writeCounterState(button, { base: base, shown: base });
        markOverflowEmpty(button, false);
        return;
      }
      const total = Number(match[0]);
      const next = Math.max(0, total - hidden);
      const target = next === total ? base : base.slice(0, match.index) + String(next) + base.slice(match.index + match[0].length);
      if (current !== target) setCounterText(button, target);
      writeCounterState(button, { base: base, shown: target });
      markOverflowEmpty(button, next === 0 && total > 0);
    }

    /** Collect every catalog row and overflow button without throwing. */
    function catalogNodes() {
      let rows = [];
      let buttons = [];
      try {
        rows = document.querySelectorAll(ROW_SELECTOR) || [];
      } catch (error) {
        warn('catalog row query failed', errorMessage(error));
        rows = [];
      }
      try {
        buttons = document.querySelectorAll(OVERFLOW_SELECTOR) || [];
      } catch (error) {
        warn('catalog counter query failed', errorMessage(error));
        buttons = [];
      }
      return { rows: rows, buttons: buttons };
    }

    /**
     * Mark branch rows hidden and correct the per-group "show more" counters.
     * Uses the Session/Workspace stores when possible so only rows that were
     * really pushed into a collapsed tail are subtracted; falls back to counting
     * rendered hidden rows inside each button's own container.
     */
    function syncCatalogCategory() {
      const nodes = catalogNodes();
      const hiddenRows = [];
      for (let i = 0; i < nodes.rows.length; i += 1) {
        const row = nodes.rows[i];
        const sessionId = rowSessionId(row);
        if (!sessionId) continue;
        const hide = hiddenBranchIds.has(sessionId);
        try {
          if (hide) {
            hiddenRows.push(row);
            if (!row.hasAttribute(HIDE_ATTR)) row.setAttribute(HIDE_ATTR, '1');
          } else if (row.hasAttribute(HIDE_ATTR)) {
            row.removeAttribute(HIDE_ATTR);
          }
        } catch (error) {
          warn('catalog row hide failed', error);
        }
      }
      if (!nodes.buttons.length) return;
      const snapshot = catalogSnapshot();
      const rendered = snapshot ? renderedHiddenTotals(hiddenRows, snapshot) : null;
      const totals = snapshot ? hiddenBranchTotals(snapshot) : null;
      for (let i = 0; i < nodes.buttons.length; i += 1) {
        const button = nodes.buttons[i];
        try {
          const key = overflowGroupKey(button);
          if (key === undefined) continue;
          let hidden;
          if (snapshot && totals && rendered) {
            const total = totals.get(key) || 0;
            const visible = rendered.get(key) || 0;
            hidden = Math.max(0, total - visible);
          } else {
            hidden = containerHiddenCount(button, hiddenRows);
          }
          patchOverflowCounter(button, hidden);
        } catch (error) {
          log('catalog counter failed', error);
        }
      }
    }

    /** True when a mutation batch can affect rows or counters. */
    function relevantCatalogMutation(records) {
      // A bare notification (some hosts and test doubles report "something
      // changed" without records) must still reach the sync pass.
      if (!records || records.length === 0) return true;
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (!record) continue;
        if (record.type === 'childList') return true;
        if (record.type === 'characterData') {
          let parent = null;
          try { parent = record.target && record.target.parentElement ? record.target.parentElement : null; } catch (e) { parent = null; }
          if (!parent || typeof parent.closest !== 'function') return true;
          try {
            if (parent.closest(OVERFLOW_SELECTOR) || parent.closest(ROW_SELECTOR)) return true;
          } catch (e) {
            return true;
          }
        }
      }
      return false;
    }

    /**
     * Keep our branches out of the left catalog without archiving them.
     *
     * The catalog renders one row per Session carrying a stable
     * data-row-key="session:<id>", plus one "show more" button carrying
     * data-row-key="overflow:<groupKey>" whose label is localized as
     * "Show {n} more sessions" / "展开其余 {n} 个会话". Hiding is presentation
     * only: the Session keeps running, keeps accepting prompts, and stays
     * reachable through its dock tab.
     * @returns disposer removing the observer, the style element and the frame.
     */
    function installCatalogHiding() {
      if (typeof document === 'undefined' || typeof MutationObserver !== 'function') {
        return function () {};
      }
      let raf = 0;
      let styleEl = null;
      let observer = null;

      const mark = function () {
        raf = 0;
        try {
          syncCatalogCategory();
        } catch (e) {
          warn('catalog sync failed', e);
        }
      };

      const schedule = function () {
        if (raf) return;
        try {
          raf = window.requestAnimationFrame(mark);
        } catch (e) {
          mark();
        }
      };

      try {
        styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', IMPL_ID + '/catalog-hide');
        styleEl.textContent = HIDE_STYLE_TEXT;
        document.head.appendChild(styleEl);
      } catch (e) {
        warn('catalog hide style failed', e);
        styleEl = null;
      }

      try {
        observer = new MutationObserver(function (records) {
          if (relevantCatalogMutation(records)) schedule();
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch (e) {
        warn('catalog observer failed', e);
      }
      mark();

      return function () {
        try { if (observer) observer.disconnect(); } catch (e) {}
        if (styleEl) { try { styleEl.remove(); } catch (e) {} }
        if (raf) { try { window.cancelAnimationFrame(raf); } catch (e) {} }
      };
    }

    /* ------------------------------------------------------------------ *
     * Session lifecycle
     * ------------------------------------------------------------------ */

    let sideCounter = 0;

    /** Give the side conversation a recognisable title in the session catalog. */
    function labelSideSession(sessions, sessionId) {
      sideCounter += 1;
      const title = t('tab.title') + ' ' + sideCounter;
      try {
        const renamed = sessions.rename(sessionId, title);
        if (renamed && typeof renamed.catch === 'function') renamed.catch(function () {});
        return title;
      } catch (e) {
        return undefined;
      }
    }

    /** The Session occupying the main column: the context a side chat must share. */
    function currentMainSessionId() {
      try {
        const uiWorkspace = getService('uiWorkspace');
        const reference = uiWorkspace && uiWorkspace.mainReference;
        const id = reference && reference.sessionId;
        return typeof id === 'string' && id !== '' ? id : undefined;
      } catch (e) {
        return undefined;
      }
    }

    /** Pull a Session id out of every shape the client contract has used. */
    function idOf(result) {
      if (typeof result === 'string' && result !== '') return result;
      if (result && typeof result.sessionId === 'string' && result.sessionId !== '') return result.sessionId;
      if (result && result.ok === true) {
        const value = result.value;
        if (value && typeof value.sessionId === 'string' && value.sessionId !== '') return value.sessionId;
        if (typeof value === 'string' && value !== '') return value;
      }
      const error = result && result.error;
      const details = error && (error.details || error.data);
      if (error && error.code === 'session/workspace-attach-failed' && details && details.sessionId) {
        return details.sessionId;
      }
      return undefined;
    }

    /** True when the Session has no turns yet, so forking it would inherit nothing. */
    function isBlankSession(sessions, sessionId) {
      try {
        const snapshot = sessions.list.getSnapshot();
        const row = snapshot && snapshot.byId && snapshot.byId[sessionId];
        if (!row) return false;
        return row.blank === true;
      } catch (e) {
        return false;
      }
    }

    /**
     * Fork the main conversation. The child carries the parent's whole transcript
     * up to this instant, which is exactly the point of a side chat: it already
     * knows what "this" and "that error above" refer to, and it can continue on
     * its own without touching the main thread.
     */
    function forkSideSession(sessions, parentSessionId) {
      return Promise.resolve()
        .then(function () {
          return sessions.fork({ sessionId: parentSessionId, increaseTitle: true });
        })
        .then(function (result) {
          const id = idOf(result);
          if (!id) throw new Error('assist-chat: fork returned no Session id');
          return id;
        });
    }

    /** Last resort: a brand-new Session in the current Workspace. */
    function createFreshSession(sessions) {
      const workspaceId = pickWorkspaceId();
      const cwd = workspaceId === undefined ? pickCwd(sessions) : undefined;
      const request = workspaceId !== undefined ? { workspaceId: workspaceId } : (cwd === undefined ? {} : { cwd: cwd });
      return Promise.resolve()
        .then(function () { return sessions.create(request); })
        .then(function (result) {
          const id = idOf(result);
          if (id) return id;
          let detail;
          try { detail = JSON.stringify(result); } catch (e) { detail = String(result); }
          const error = result && result.error;
          if (error) detail = '[' + [error.code, error.message].filter(Boolean).join(' / ') + '] ' + detail;
          throw new Error('assist-chat: create failed ' + (detail || 'unknown error').slice(0, 300));
        });
    }

    /** Whether the branch still exists in the catalog snapshot. */
    function isAlive(sessions, sessionId) {
      try {
        const snapshot = sessions.list.getSnapshot();
        return !!(snapshot && snapshot.byId && snapshot.byId[sessionId]);
      } catch (e) {
        return true;
      }
    }

    /**
     * Create the branch a tab body renders: a fork of the main conversation as it
     * is right now, or a fresh Session when there is no parent/blank parent.
     * @param parentSessionId - conversation to fork, if any.
     * @returns promise of the branch Session id.
     */
    function createSideSession(parentSessionId) {
      const sessions = sessionsService();
      if (!sessions) return Promise.reject(new Error('assist-chat: sessions service is unavailable'));
      const canFork = parentSessionId !== undefined && parentSessionId !== '' && !isBlankSession(sessions, parentSessionId);
      return Promise.resolve()
        .then(function () {
          if (!canFork) return undefined;
          return forkSideSession(sessions, parentSessionId).catch(function (error) {
            warn('fork failed, falling back to a fresh Session', error);
            return undefined;
          });
        })
        .then(function (forked) {
          if (forked !== undefined) return forked;
          return createFreshSession(sessions);
        })
        .then(function (sessionId) {
          if (!sessionId) throw new Error('assist-chat: no Session was produced for the side chat');
          hiddenBranchIds.add(sessionId);
          ensureWritable(sessionId);
          labelSideSession(sessions, sessionId);
          return sessionId;
        });
    }

    /**
     * Retire a branch whose tab was closed: archive it so the left catalog does
     * not grow one entry per visit. Safe here only because the branch is idle —
     * the archived-session gate rejects model steps, and we never step it again.
     * @param sessionId - branch Session id.
     */
    function retireSideSession(sessionId) {
      if (!sessionId) return;
      hiddenBranchIds.delete(sessionId);
      try {
        const uiWorkspace = getService('uiWorkspace');
        if (!uiWorkspace || typeof uiWorkspace.archiveSession !== 'function') return;
        const pending = uiWorkspace.archiveSession(sessionId);
        if (pending && typeof pending.catch === 'function') pending.catch(function (error) {
          warn('retire side session failed', error);
        });
      } catch (e) {
        warn('retire side session failed', e);
      }
    }

    /* ------------------------------------------------------------------ *
     * Components
     * ------------------------------------------------------------------ */

    function FixedChatView(props) {
      return h(Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }));
    }

    function AssistConversation(props) {
      const parts = props || {};
      const session = parts.useSession(function (value) { return value; });
      const conversation = parts.useConversation(function (value) { return value; });
      const summaryBlank = parts.useSessions
        ? parts.useSessions(function (state) { return state.byId[parts.sessionId] && state.byId[parts.sessionId].blank; })
        : undefined;
      const activeTargets = conversation && conversation.activeTargets ? conversation.activeTargets.size : 0;
      const shellPhase = activeTargets > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
        ? 'active'
        : (session.promptAttempted ? 'engaging' : 'blank');
      const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true;
      const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true);
      if (typeof parts.renderFactorySlot !== 'function') {
        return h('div', { className: 'dac-status' },
          h('div', { className: 'dac-status-text' }, t('status.error')));
      }
      return parts.renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: settling ? 'settling' : (hero ? 'hero' : 'active'),
        hero: hero
      }, { slots: { views: FixedChatView } });
    }

    /**
     * Own the branch for one tab body: create it on mount, retain it while the tab
     * lives, release and archive it on unmount. Retrying restarts from scratch.
     * @param parentSessionId - conversation to fork.
     * @returns [state, retry].
     */
    function useSideSession(parentSessionId) {
      const statePair = React.useState({ phase: 'creating' });
      const setState = statePair[1];
      const attemptPair = React.useState(0);
      const setAttempt = attemptPair[1];
      const liveRef = React.useRef(null);

      React.useEffect(function () {
        let cancelled = false;
        let live = null;
        const controller = new AbortController();
        const sessions = sessionsService();
        setState({ phase: 'creating' });
        if (!sessions) {
          setState({ phase: 'error', error: new Error('assist-chat: sessions service is unavailable') });
          return undefined;
        }
        (async function () {
          try {
            // Always a fresh fork: the seat shows the main conversation as it is
            // at the moment you open it, never a snapshot from an earlier visit.
            const sessionId = await createSideSession(parentSessionId);
            if (cancelled) { retireSideSession(sessionId); return; }
            const reference = sessions.retain(sessionId, { source: IMPL_ID + '/sidebar', signal: controller.signal });
            live = { sessionId: sessionId, reference: reference };
            liveRef.current = live;
            if (cancelled) return;
            setState({ phase: 'ready', sessionId: sessionId, reference: reference });
          } catch (error) {
            if (!cancelled) setState({ phase: 'error', error: error });
          }
        })();
        return function () {
          cancelled = true;
          try { controller.abort(); } catch (e) {}
          const current = liveRef.current || live;
          liveRef.current = null;
          if (current) {
            try { current.reference.release(); } catch (e) {}
            retireSideSession(current.sessionId);
          }
        };
      }, [attemptPair[0], parentSessionId]);

      const retry = React.useCallback(function () {
        setAttempt(function (n) { return n + 1; });
      }, []);

      return [statePair[0], retry];
    }

    function AssistTab(props) {
      const parts = props || {};
      // The dock's layout is per-Session, so the seat knows which main
      // conversation it belongs to through its own tab navigation params.
      // The guide-page entry has no params, so fall back to whatever the main
      // column is showing right now.
      const useTabInfo = parts.useTabInfo;
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
      const navigation = tabInfo && tabInfo.tab ? tabInfo.tab.navigation : null;
      const params = navigation ? navigation.params : null;
      const parentParam = params && typeof params.parent === 'string' ? params.parent : '';
      const scopeSessionId = typeof parts.sessionId === 'string' ? parts.sessionId : '';
      const parentSessionId = parentParam !== '' ? parentParam : (scopeSessionId !== '' ? scopeSessionId : currentMainSessionId());
      const sideState = useSideSession(parentSessionId);
      const state = sideState[0];
      const retry = sideState[1];

      if (state.phase !== 'ready') {
        const failed = state.phase === 'error';
        const detail = failed && state.error ? String((state.error && state.error.message) || state.error) : '';
        return h('div', { className: 'dac-status' },
          h('div', { className: 'dac-status-text' }, failed ? t('status.error') : t('status.creating')),
          detail ? h('div', { className: 'dac-status-detail' }, detail) : null,
          failed ? h('button', { type: 'button', className: 'dac-btn', onClick: retry }, t('retry')) : null
        );
      }
      if (typeof parts.renderSlot !== 'function' || !parts.SessionProvider) {
        return h('div', { className: 'dac-status' },
          h('div', { className: 'dac-status-text' }, t('status.error')));
      }
      return h('div', { className: 'dac-root', 'data-assist-chat': '' },
        h(parts.SessionProvider, { session: state.reference }, parts.renderSlot(CONV_SLOT, {}))
      );
    }

    function AssistGlyph() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true'
      },
        h('path', { d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' }),
        h('path', { d: 'M12 8v6M9 11h6' }));
    }

    function AssistHeaderButton() {
      return h('button', {
        type: 'button',
        className: 'dac-header-btn',
        title: t('header.buttonTitle'),
        'aria-label': t('header.buttonTitle'),
        onClick: function (event) {
          try {
            if (event) { event.preventDefault(); event.stopPropagation(); }
          } catch (e) {}
          openSideChat();
        }
      }, h(AssistGlyph, null), h('span', { className: 'dac-header-btn-text' }, t('header.button')));
    }

    /* ------------------------------------------------------------------ *
     * Navigation + global shortcut
     * ------------------------------------------------------------------ */

    /**
     * Open (or focus) the side-chat seat for the conversation on screen.
     *
     * sidebarRight.openTab records a page at the address this package composes
     * for the kind; because the tab type is single-instance, the product reveals
     * and focuses the existing tab instead of minting a second one. The parent id
     * rides the tab navigation params, so the seat always renders the branch of
     * the conversation that owns it.
     * @param options - requireMain refuses to open without a main Session.
     * @returns the path used ("openTab"/"openRightbar"), or false when nothing opened.
     */
    function openSideChat(options) {
      const settings = options || {};
      const parentSessionId = currentMainSessionId();
      if (settings.requireMain === true && !parentSessionId) {
        warn('no main Session on screen; side chat ignored');
        return false;
      }
      const sidebarRight = getService('sidebarRight');
      if (sidebarRight && typeof sidebarRight.openTab === 'function') {
        try {
          if (parentSessionId) sidebarRight.openTab(KIND, { params: { parent: parentSessionId } });
          else sidebarRight.openTab(KIND);
          return 'openTab';
        } catch (error) {
          warn('openTab failed', error);
        }
      } else {
        warn('sidebarRight service is unavailable');
      }
      // Fall back to just revealing the dock; the seat renders its own state.
      const layout = getService('layout');
      try {
        if (layout && typeof layout.openRightbar === 'function') {
          layout.openRightbar();
          return 'openRightbar';
        }
      } catch (e) {
        warn('openRightbar failed', e);
      }
      return false;
    }

    /** Close the current side-chat tab and reopen it, producing a fresh fork. */
    function newSideChat() {
      const parentSessionId = currentMainSessionId();
      const sidebarRight = getService('sidebarRight');
      if (!sidebarRight) return;
      // Closing unmounts the seat, which retires the old branch; reopening then
      // forks the main conversation again at its current state.
      try {
        if (typeof sidebarRight.close === 'function' && typeof sidebarRight.tabsIn === 'function' && parentSessionId) {
          const tabs = sidebarRight.tabsIn(parentSessionId) || [];
          for (let i = 0; i < tabs.length; i += 1) {
            const tab = tabs[i];
            if (tab && tab.kind === KIND && tab.id) { sidebarRight.close(tab.id); break; }
          }
        }
      } catch (e) {
        warn('close failed', e);
      }
      setTimeout(function () { openSideChat(); }, 30);
    }

    /** The command definition handed to the product's shortcut registry. */
    function shortcutDefinition() {
      return {
        id: SHORTCUT_ID,
        label: function () { return t('shortcut.open'); },
        aliases: ['side chat', 'assist chat', '辅助对话'],
        defaults: SHORTCUT_DEFAULTS,
        regions: SHORTCUT_REGIONS,
        modals: [],
        resolve: shortcutResolve
      };
    }

    /**
     * Shortcut resolution: only a real main conversation gets a side chat. With
     * no Session on screen the command is blocked (and the host reports the
     * localized reason) instead of opening a panel nobody asked for.
     * @returns an object with status handled or blocked.
     */
    function shortcutResolve() {
      if (!currentMainSessionId()) return { status: 'blocked', reason: t('shortcut.noSession') };
      return {
        status: 'handled',
        run: function () { openSideChat({ requireMain: true }); }
      };
    }

    /**
     * Register the command with the product's shortcut service. Optional: older
     * hosts and unit-test mocks may not expose it, in which case the capture-phase
     * fallback below is the only trigger.
     * @param shortcuts - Client shortcuts service.
     * @returns disposer, or null when registration was not possible.
     */
    function registerShortcutCommand(shortcuts) {
      if (!shortcuts || typeof shortcuts.register !== 'function') return null;
      try {
        const dispose = shortcuts.register(shortcutDefinition());
        return typeof dispose === 'function' ? dispose : function () {};
      } catch (error) {
        warn('shortcut registration failed', error);
        return null;
      }
    }

    /**
     * Wire the shortcut command through the service, waiting for it when the host
     * exposes ctx.inject. The DOM fallback is installed separately and always.
     * @param ctx - plugin context.
     * @returns disposer releasing the command.
     */
    function installShortcutCommand(ctx) {
      let disposeCommand = null;
      const release = function () {
        try { if (disposeCommand) disposeCommand(); } catch (e) {}
        disposeCommand = null;
      };
      const adopt = function (shortcuts) {
        if (disposeCommand) return true;
        const dispose = registerShortcutCommand(shortcuts);
        if (!dispose) return false;
        disposeCommand = dispose;
        return true;
      };
      try {
        if (typeof ctx.inject === 'function') {
          // Cordis starts a nested plugin and calls back once the dependency is
          // mounted; the nested fiber is disposed with this plugin.
          ctx.inject(['shortcuts'], function assistChatShortcut(scope) {
            try {
              let shortcuts;
              try {
                shortcuts = scope && (scope.shortcuts || (typeof scope.get === 'function' ? scope.get('shortcuts') : undefined));
              } catch (e) { shortcuts = undefined; }
              if (!adopt(shortcuts)) warn('shortcuts service is unavailable; the keydown fallback stays in charge');
            } catch (error) {
              warn('shortcut service wiring failed', error);
            }
          });
          return release;
        }
        if (!adopt(getService('shortcuts'))) warn('shortcuts service is unavailable; the keydown fallback stays in charge');
      } catch (error) {
        warn('shortcut wiring failed', error);
      }
      return release;
    }

    /**
     * Capture-phase Ctrl+Shift+B fallback.
     *
     * The Web build binds the same chord to sidebar.right.toggle and dispatches it
     * from a bubble-phase window listener. A capture listener therefore runs
     * first and can consume the event, so the plugin action wins instead of
     * collapsing the dock. The listener only consumes the exact chord, only when
     * a main conversation is on screen, and only when not composing in an input
     * method; plain typing never matches because Ctrl/Cmd and Shift are required.
     * @returns disposer removing the listener.
     */
    function installShortcutFallback() {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return function () {};
      }
      let lastRunAt = 0;
      const onKeyDown = function (event) {
        try {
          if (!event || event.defaultPrevented || event.repeat === true || event.isComposing === true) return;
          if (event.code !== SHORTCUT_KEY_CODE) return;
          if (event.shiftKey !== true || event.altKey === true) return;
          if (event.ctrlKey !== true && event.metaKey !== true) return;
          // Never fight a modal or a focused embedded surface.
          const target = event.target;
          if (target && typeof target.closest === 'function') {
            try {
              if (target.closest('[role="dialog"], [aria-modal="true"]')) return;
            } catch (e) {}
          }
          if (!currentMainSessionId()) return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
          else if (typeof event.stopPropagation === 'function') event.stopPropagation();
          const now = Date.now();
          // Desktop routes the same command through the native bridge and may
          // also deliver DOM input; run the action once per press.
          if (now - lastRunAt < SHORTCUT_DEBOUNCE_MS) return;
          lastRunAt = now;
          openSideChat({ requireMain: true });
        } catch (error) {
          warn('shortcut fallback failed', error);
        }
      };
      try {
        window.addEventListener('keydown', onKeyDown, true);
      } catch (error) {
        warn('shortcut listener failed', error);
        return function () {};
      }
      return function () {
        try { window.removeEventListener('keydown', onKeyDown, true); } catch (e) {}
      };
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = [
      '.dac-root{display:flex;flex-direction:column;min-height:0;height:100%;width:100%;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#111)}',
      '.dac-status{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:24px;font-size:13px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dac-status-text{text-align:center;line-height:1.6}',
      '.dac-status-detail{max-width:320px;text-align:center;line-height:1.5;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary,#9aa3ad);word-break:break-word}',
      '.dac-btn{font:inherit;font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#dcdfe4);background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-primary,#111)}',
      '.dac-btn:hover{filter:brightness(.97)}',
      '.dac-header-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.dac-header-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#111)}',
      '.dac-header-btn:active{transform:translateY(.5px)}',
      '.dac-header-btn svg{flex:none;opacity:.9}',
      '.dac-header-btn-text{white-space:nowrap}'
    ].join('\n');

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'layout', 'sessions', 'sidebarRight', 'sidebarRightTabs'],
      apply: function (ctx) {
        rootCtx = ctx;

        try {
          const service = ctx.get('locale');
          if (service && typeof service.register === 'function') {
            localeSvc = service;
            try { service.register(NS, 'zh', ZH); } catch (e) { warn('locale zh', e); }
            try { service.register(NS, 'en', EN); } catch (e) { warn('locale en', e); }
          }
        } catch (e) { warn('locale service', e); }

        ctx.effect(function () {
          const el = document.createElement('style');
          el.setAttribute('data-plugin', IMPL_ID);
          el.textContent = CSS;
          document.head.appendChild(el);
          return function () { try { el.remove(); } catch (e) {} };
        });

        ctx.effect(function () { return installCatalogHiding(); });
        ctx.effect(function () { return installShortcutCommand(ctx); });
        ctx.effect(function () { return installShortcutFallback(); });

        ctx.effect(function () {
          const registry = getService('sidebarRightTabs');
          if (!registry || typeof registry.register !== 'function') {
            registryState = { registered: false, error: 'sidebarRightTabs service is unavailable' };
            warn(registryState.error);
            return function () {};
          }
          const state = { registered: true, error: null };
          registryState = state;
          return withRegistry(registry, state);
        });

        function withRegistry(registry, state) {
          try {
            return registry.register({
              id: IMPL_ID,
              kind: KIND,
              priority: 'extension',
              // Kept mounted across tab switches and dock collapse so the branch
              // and its transcript survive until the tab itself is closed.
              keepMounted: true,
              title: function () { return t('tab.title'); },
              guide: [{
                id: 'assist',
                order: 30,
                title: function () { return t('guide.title'); },
                description: function () { return t('guide.description'); },
                icon: AssistGlyph
              }]
            });
          } catch (error) {
            state.registered = false;
            state.error = errorMessage(error);
            warn('tab type registration failed', error);
            return function () {};
          }
        }

        ctx.effect(function () {
          return ctx.slots.inject(TAB_SLOT, function () {
            return ctx.slots.register({
              name: TAB_SLOT,
              key: IMPL_ID,
              children: { 'sidebar.assist.conversation': { kind: 'single', scope: 'session' } }
            }, AssistTab);
          });
        });

        ctx.effect(function () {
          return ctx.slots.inject(CONV_SLOT, function () {
            return ctx.slots.register({ name: CONV_SLOT }, AssistConversation);
          });
        });

        ctx.effect(function () {
          return ctx.slots.inject(HEADER_SLOT, function () {
            return ctx.slots.register({
              name: HEADER_SLOT,
              id: 'assist-chat-open',
              order: 60
            }, AssistHeaderButton);
          });
        });
      }
    };
  }
});
