// Assist chat — Client half.
//
// A right-dock seat that opens a *separate* Session: the side conversation has
// its own transcript, its own agent and its own context, so asking it something
// never disturbs the main thread. The panel reuses the product's own
// Conversation surface ("conversation.content") instead of redrawing a chat, so
// markdown, tool calls, approvals and streaming all behave exactly like the main
// conversation.
window.__ModuleLoader__.load({
  id: 'dsh-assist-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const Fragment = React.Fragment;

    const NS = 'dsh-assist-chat';
    const IMPL_ID = 'dsh-assist-chat';
    const KIND = 'assistchat';
    const CONV_SLOT = 'sidebar.assist.conversation';
    const DEBUG = false;

    function log() {
      if (!DEBUG) return;
      try { console.log.apply(console, ['[assist-chat]'].concat([].slice.call(arguments))); } catch (e) {}
    }
    function warn() {
      try { console.warn.apply(console, ['[assist-chat]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    const ZH = {
      'tab.title': '辅助对话',
      'guide.title': '辅助对话',
      'guide.description': '开一个与主对话隔离的旁支会话，随时追问而不打断主线',
      'header.button': '辅助对话',
      'header.buttonTitle': '在右侧栏开启辅助对话',
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
      'status.creating': 'Preparing side chat…',
      'status.error': 'Could not open side chat',
      'retry': 'Retry'
    };

    let rootCtx = null;
    let localeSvc = null;
    let registryState = null;

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

    /* ---------------- session plumbing ---------------- */

    // Branches that must not show up in the left catalog. Hidden at the DOM level
    // rather than archived: an archived Session cannot run a model step, so
    // hiding through data would silently make the side chat read-only.
    const hiddenBranchIds = new Set();

    // Lifecycle of a branch is the lifecycle of its tab, deliberately:
    //   open the seat  -> fork the main conversation *as it is right now*
    //   keep it open   -> the same branch (keepMounted keeps it mounted)
    //   close the tab  -> retire that branch (archive it, so the catalog stays clean)
    // Caching per parent across openings would serve a stale snapshot forever,
    // which is exactly what a side chat must not do.

    function getService(name) {
      try { return rootCtx ? rootCtx.get(name) : undefined; } catch (e) { return undefined; }
    }

    function sessionsService() {
      return getService('sessions') || null;
    }

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

    /** The Workspace a side conversation should be filed under. */
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

    /**
     * Keep our branches out of the left catalog without archiving them.
     *
     * The catalog renders one row per Session carrying a stable
     * data-row-key="session:<id>", so hiding is a matter of marking the rows
     * whose id we minted. Presentation only: the Session keeps running, keeps
     * accepting prompts, and stays reachable through its dock tab.
     */
    function installCatalogHiding() {
      if (typeof document === 'undefined' || typeof MutationObserver !== 'function') {
        return function () {};
      }
      const ATTR = 'data-assist-hidden';
      let raf = 0;
      let styleEl = null;
      let observer = null;

      const mark = function () {
        raf = 0;
        try {
          const rows = document.querySelectorAll('[data-row-key^="session:"]');
          for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            const key = row.getAttribute('data-row-key') || '';
            const id = key.slice('session:'.length);
            const hide = hiddenBranchIds.has(id);
            if (hide && !row.hasAttribute(ATTR)) row.setAttribute(ATTR, '1');
            else if (!hide && row.hasAttribute(ATTR)) row.removeAttribute(ATTR);
          }
        } catch (e) {
          warn('catalog hide failed', e);
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

      styleEl = document.createElement('style');
      styleEl.setAttribute('data-plugin', IMPL_ID + '/catalog-hide');
      styleEl.textContent = '[data-assist-hidden]{display:none !important}';
      document.head.appendChild(styleEl);

      observer = new MutationObserver(schedule);
      try {
        observer.observe(document.body, { childList: true, subtree: true });
      } catch (e) {
        warn('catalog observer failed', e);
      }
      mark();

      return function () {
        try { observer.disconnect(); } catch (e) {}
        if (styleEl) { try { styleEl.remove(); } catch (e) {} }
        if (raf) { try { window.cancelAnimationFrame(raf); } catch (e) {} }
      };
    }

    /** Give the side conversation a recognisable title in the session catalog. */
    let sideCounter = 0;

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

    function isAlive(sessions, sessionId) {
      try {
        const snapshot = sessions.list.getSnapshot();
        return !!(snapshot && snapshot.byId && snapshot.byId[sessionId]);
      } catch (e) {
        return true;
      }
    }

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
     */
    function retireSideSession(sessionId) {
      if (!sessionId) return;
      try {
        const uiWorkspace = getService('uiWorkspace');
        if (!uiWorkspace || typeof uiWorkspace.archiveSession !== 'function') return;
        const pending = uiWorkspace.archiveSession(sessionId);
        if (pending && typeof pending.catch === 'function') pending.catch(function () {});
      } catch (e) {
        warn('retire side session failed', e);
      }
    }

    /* ---------------- components ---------------- */

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

    /** Open (or focus) the side-chat seat for the conversation on screen. */
    function openSideChat() {
      const sidebarRight = getService('sidebarRight');
      if (!sidebarRight || typeof sidebarRight.openTab !== 'function') {
        warn('sidebarRight service is unavailable');
        return;
      }
      const parentSessionId = currentMainSessionId();
      try {
        // The parent id rides the tab's navigation params so this seat always
        // renders the branch belonging to the conversation that owns it.
        if (parentSessionId) sidebarRight.openTab(KIND, { params: { parent: parentSessionId } });
        else sidebarRight.openTab(KIND);
        return;
      } catch (error) {
        warn('openTab failed', error);
      }
      // Fall back to just revealing the dock; the seat renders its own state.
      const layout = getService('layout');
      try {
        if (layout && typeof layout.openRightbar === 'function') layout.openRightbar();
      } catch (e) {
        warn('openRightbar failed', e);
      }
    }

    function newSideChat() {
      const sidebarRight = getService('sidebarRight');
      if (!sidebarRight) return;
      // Closing unmounts the seat, which retires the old branch; reopening then
      // forks the main conversation again at its current state.
      try {
        if (typeof sidebarRight.close === 'function') sidebarRight.close(KIND);
      } catch (e) {
        warn('close failed', e);
      }
      setTimeout(function () { openSideChat(); }, 30);
    }

    /* ---------------- styles ---------------- */

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

    /* ---------------- plugin ---------------- */

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
            state.error = String((error && error.message) || error);
            warn('tab type registration failed', error);
            return function () {};
          }
        }

        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register({
              name: 'sidebar.right.pane.tab',
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
          return ctx.slots.inject('conversation.session.header.actions', function () {
            return ctx.slots.register({
              name: 'conversation.session.header.actions',
              id: 'assist-chat-open',
              order: 60
            }, AssistHeaderButton);
          });
        });
      }
    };
  }
});
