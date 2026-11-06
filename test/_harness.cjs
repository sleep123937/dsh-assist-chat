// Shared test harness for the assist-chat Client module.
//
// Loads client.js into a mocked DSH client host (vm context) and provides:
//   - a miniature React runtime (hooks + effects) so components can be mounted
//     and their lifecycles driven from plain Node,
//   - DOM / MutationObserver / requestAnimationFrame mocks backed by an
//     inspectable element registry (session catalog rows, count nodes, ...),
//   - host services (sessions, uiWorkspace, sidebarRight, shortcuts, locale, ...)
//     whose calls are recorded for assertions.
//
// The harness never touches a real DSH: everything below is deterministic.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// DSH_ASSIST_CLIENT_PATH lets a maintainer point the suites at a mutated copy
// (used to prove the assertions actually bite); unset in normal runs.
const CLIENT_PATH = process.env.DSH_ASSIST_CLIENT_PATH || path.join(__dirname, '..', 'client.js');
const PLUGIN_ID = 'dsh-assist-chat';
const KIND = 'assistchat';
const CONV_SLOT = 'sidebar.assist.conversation';
const NS = 'dsh-assist-chat';

function readClientSource() {
  return fs.readFileSync(CLIENT_PATH, 'utf8');
}

/* ------------------------------------------------------------------ *
 * Tiny React runtime
 * ------------------------------------------------------------------ */

function sameDeps(previous, next) {
  if (!previous || !next || previous.length !== next.length) return false;
  for (let i = 0; i < previous.length; i += 1) {
    if (!Object.is(previous[i], next[i])) return false;
  }
  return true;
}

function createReactRuntime() {
  let currentInstance = null;

  function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    let normalized;
    if (children.length === 0) normalized = undefined;
    else if (children.length === 1) normalized = children[0];
    else normalized = children;
    return { type, props: props || {}, children: normalized };
  }

  function current(name) {
    if (!currentInstance) throw new Error(name + ' called outside of a component render');
    return currentInstance;
  }

  function useState(initial) {
    const instance = current('useState');
    const index = instance.hookIndex;
    instance.hookIndex += 1;
    let slot = instance.hooks[index];
    if (!slot) {
      slot = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      instance.hooks[index] = slot;
    }
    const setState = function (next) {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      instance.invalidate();
    };
    return [slot.value, setState];
  }

  function useEffect(fn, deps) {
    const instance = current('useEffect');
    const index = instance.hookIndex;
    instance.hookIndex += 1;
    const normalized = Array.isArray(deps) ? deps.slice() : null;
    let slot = instance.hooks[index];
    if (!slot) {
      instance.hooks[index] = { kind: 'effect', deps: normalized, fn, pending: true, cleanup: null };
      return;
    }
    slot.fn = fn;
    if (deps === undefined || !sameDeps(slot.deps, normalized)) {
      slot.deps = normalized;
      slot.pending = true;
    }
  }

  function useLayoutEffect(fn, deps) {
    return useEffect(fn, deps);
  }

  function useRef(initial) {
    const instance = current('useRef');
    const index = instance.hookIndex;
    instance.hookIndex += 1;
    let slot = instance.hooks[index];
    if (!slot) {
      slot = { kind: 'ref', ref: { current: initial } };
      instance.hooks[index] = slot;
    }
    return slot.ref;
  }

  function useCallback(fn) {
    const instance = current('useCallback');
    const index = instance.hookIndex;
    instance.hookIndex += 1;
    let slot = instance.hooks[index];
    if (!slot) {
      slot = { kind: 'callback', fn };
      instance.hooks[index] = slot;
    } else {
      slot.fn = fn;
    }
    return function () { return slot.fn.apply(this, arguments); };
  }

  function useMemo(factory, deps) {
    const instance = current('useMemo');
    const index = instance.hookIndex;
    instance.hookIndex += 1;
    const normalized = Array.isArray(deps) ? deps.slice() : null;
    let slot = instance.hooks[index];
    if (!slot || !sameDeps(slot.deps, normalized)) {
      slot = { kind: 'memo', deps: normalized, value: factory() };
      instance.hooks[index] = slot;
    }
    return slot.value;
  }

  function flushEffects(instance) {
    if (instance.unmounted) return;
    instance.flushing = true;
    const hooks = instance.hooks;
    for (let i = 0; i < hooks.length; i += 1) {
      const slot = hooks[i];
      if (!slot || slot.kind !== 'effect' || !slot.pending) continue;
      slot.pending = false;
      if (typeof slot.cleanup === 'function') {
        const cleanup = slot.cleanup;
        slot.cleanup = null;
        try {
          cleanup();
        } catch (error) {
          instance.errors.push({ hook: i, phase: 'cleanup', error });
        }
      }
      if (instance.unmounted) break;
      try {
        const cleanup = slot.fn();
        slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
      } catch (error) {
        slot.cleanup = null;
        instance.errors.push({ hook: i, phase: 'effect', error });
      }
    }
    instance.flushing = false;
    if (instance.pendingRender && !instance.unmounted) {
      instance.pendingRender = false;
      renderInstance(instance);
    }
  }

  function renderInstance(instance) {
    if (instance.unmounted) return;
    instance.hookIndex = 0;
    instance.renderCount += 1;
    const previous = currentInstance;
    currentInstance = instance;
    try {
      instance.tree = instance.Component(instance.props);
    } finally {
      currentInstance = previous;
    }
    flushEffects(instance);
  }

  function mount(Component, props) {
    const instance = {
      Component,
      props: props || {},
      hooks: [],
      hookIndex: 0,
      renderCount: 0,
      tree: undefined,
      unmounted: false,
      flushing: false,
      pendingRender: false,
      errors: [],
    };
    instance.invalidate = function () {
      if (instance.unmounted) return;
      if (instance.flushing) {
        instance.pendingRender = true;
        return;
      }
      renderInstance(instance);
    };
    renderInstance(instance);
    return {
      instance,
      get tree() { return instance.tree; },
      get errors() { return instance.errors; },
      rerender: function () { renderInstance(instance); },
      setProps: function (nextProps) {
        instance.props = nextProps || {};
        instance.invalidate();
      },
      unmount: function () {
        if (instance.unmounted) return;
        instance.unmounted = true;
        for (let i = instance.hooks.length - 1; i >= 0; i -= 1) {
          const slot = instance.hooks[i];
          if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') {
            const cleanup = slot.cleanup;
            slot.cleanup = null;
            try {
              cleanup();
            } catch (error) {
              instance.errors.push({ hook: i, phase: 'unmount', error });
            }
          }
        }
      },
    };
  }

  return {
    createElement,
    useState,
    useEffect,
    useLayoutEffect,
    useRef,
    useCallback,
    useMemo,
    Fragment: Symbol('Fragment'),
    mount,
  };
}

/* ------------------------------------------------------------------ *
 * DOM stubs
 * ------------------------------------------------------------------ */

function parseSelector(selector) {
  const groups = String(selector == null ? '' : selector)
    .split(',')
    .map(function (part) { return part.trim(); })
    .filter(Boolean);
  const matchers = [];
  const tokenRe = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:([~^$*|]?=)\s*["']?([^\]"']*)["']?)?\]/g;
  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g];
    const checks = [];
    tokenRe.lastIndex = 0;
    let match;
    while ((match = tokenRe.exec(group)) !== null) {
      if (match[1]) {
        const tag = match[1].toLowerCase();
        checks.push(function (el) { return String(el.tag || el.tagName || '').toLowerCase() === tag; });
      } else if (match[2]) {
        const cls = match[2];
        checks.push(function (el) {
          const className = ' ' + String(el.className || '') + ' ';
          return className.indexOf(' ' + cls + ' ') >= 0;
        });
      } else if (match[3]) {
        const id = match[3];
        checks.push(function (el) { return el.id === id; });
      } else if (match[4]) {
        const name = match[4];
        const op = match[5];
        const value = match[6] === undefined ? '' : match[6].trim();
        checks.push(function (el) {
          const actual = typeof el.getAttribute === 'function' ? el.getAttribute(name) : undefined;
          if (actual === null || actual === undefined) return false;
          if (!op) return true;
          const text = String(actual);
          if (op === '=') return text === value;
          if (op === '^=') return text.indexOf(value) === 0;
          if (op === '$=') return text.endsWith(value);
          if (op === '*=') return text.indexOf(value) >= 0;
          return false;
        });
      }
    }
    matchers.push(function (el) {
      for (let c = 0; c < checks.length; c += 1) {
        if (!checks[c](el)) return false;
      }
      return true;
    });
  }
  return matchers;
}

function createElementStub(tag) {
  const listeners = Object.create(null);
  const attrs = Object.create(null);
  const element = {
    nodeType: 1,
    tag: String(tag || 'div').toLowerCase(),
    id: '',
    className: '',
    textContent: '',
    innerText: '',
    style: {},
    dataset: {},
    children: [],
    childNodes: [],
    parentNode: null,
    parentElement: null,
    __removed: false,
    getAttribute: function (name) {
      const value = attrs[String(name)];
      return value === undefined ? null : value;
    },
    setAttribute: function (name, value) {
      attrs[String(name)] = String(value);
      if (name === 'class') element.className = String(value);
      if (name === 'id') element.id = String(value);
    },
    removeAttribute: function (name) { delete attrs[String(name)]; },
    hasAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(attrs, String(name));
    },
    appendChild: function (child) {
      element.children.push(child);
      element.childNodes.push(child);
      if (child && typeof child === 'object') {
        child.parentNode = element;
        child.parentElement = element;
      }
      return child;
    },
    removeChild: function (child) {
      const index = element.children.indexOf(child);
      if (index >= 0) element.children.splice(index, 1);
      const nodeIndex = element.childNodes.indexOf(child);
      if (nodeIndex >= 0) element.childNodes.splice(nodeIndex, 1);
      if (child) {
        child.parentNode = null;
        child.parentElement = null;
      }
      return child;
    },
    remove: function () {
      element.__removed = true;
      if (element.parentNode) element.parentNode.removeChild(element);
    },
    addEventListener: function (type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    removeEventListener: function (type, fn) {
      const list = listeners[type];
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent: function (event) {
      const list = listeners[event && event.type] || [];
      for (let i = 0; i < list.length; i += 1) {
        try { list[i](event); } catch (error) { element.__dispatchError = error; }
      }
      return true;
    },
    click: function () {
      element.dispatchEvent({
        type: 'click',
        target: element,
        currentTarget: element,
        preventDefault: function () {},
        stopPropagation: function () {},
      });
    },
    querySelector: function (selector) { return element.querySelectorAll(selector)[0] || null; },
    querySelectorAll: function (selector) {
      const matchers = parseSelector(selector);
      const out = [];
      const walk = function (node) {
        const children = node.children || [];
        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];
          if (!child || child.nodeType !== 1) continue;
          for (let m = 0; m < matchers.length; m += 1) {
            if (matchers[m](child)) { out.push(child); break; }
          }
          walk(child);
        }
      };
      walk(element);
      return out;
    },
    __listeners: listeners,
    __attrs: attrs,
  };
  return element;
}

function createDocument(host) {
  const listeners = Object.create(null);
  const elements = [];
  const document = {
    __elements: elements,
    __listeners: listeners,
    createElement: function (tag) {
      const element = createElementStub(tag);
      elements.push(element);
      return element;
    },
    createTextNode: function (text) {
      return { nodeType: 3, textContent: String(text), parentNode: null };
    },
    addEventListener: function (type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    removeEventListener: function (type, fn) {
      const list = listeners[type];
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    querySelector: function (selector) { return document.querySelectorAll(selector)[0] || null; },
    querySelectorAll: function (selector) {
      const matchers = parseSelector(selector);
      return elements.filter(function (element) {
        if (!element || element.__removed) return false;
        for (let i = 0; i < matchers.length; i += 1) {
          if (matchers[i](element)) return true;
        }
        return false;
      });
    },
  };
  document.head = createElementStub('head');
  document.head.appendChild = function (child) {
    document.head.children.push(child);
    document.head.childNodes.push(child);
    if (child) child.parentNode = document.head;
    return child;
  };
  document.body = createElementStub('body');
  document.documentElement = createElementStub('html');
  elements.push(document.documentElement, document.head, document.body);
  return document;
}

/* ------------------------------------------------------------------ *
 * Host
 * ------------------------------------------------------------------ */

function createHost(options) {
  const opts = options || {};
  const host = { options: opts, __captured: null, plugin: null };
  const state = {
    sessionsSnapshot: {
      ids: ['main-1'],
      byId: { 'main-1': { sessionId: 'main-1', cwd: 'D:/work', updatedAt: 5, blank: false } },
    },
    nextSideId: 'side-1',
    forkImpl: null,
    createImpl: null,
    forkRequests: [],
    createRequests: [],
    retained: [],
    released: [],
    renamed: [],
    workspaceItems: [{ workspaceId: 'ws-1', title: 'Work', sessionIds: ['main-1'] }],
    mainReference: { sessionId: 'main-1' },
    archivedSessionIds: [],
    archived: [],
    unarchived: [],
    openedTabs: [],
    closedTabs: [],
    layoutCalls: [],
    tabTypes: [],
    disposedTabTypes: [],
    slotRegistrations: [],
    slotInjects: [],
    injectRequests: [],
    localeRegistrations: [],
    localeTCalls: [],
    localeTImpl: null,
    shortcutDefs: [],
    disposedShortcuts: [],
    commandTargets: [],
    commandTargetValue: undefined,
    getThrows: false,
    warnings: [],
    logs: [],
    errors: [],
    mutationObservers: [],
    rafQueue: new Map(),
    rafSeq: 0,
    styleEls: [],
    effects: [],
    pendingInjects: [],
  };
  host.state = state;

  const sessions = {
    list: { getSnapshot: function () { return state.sessionsSnapshot; } },
    fork: function (request) {
      state.forkRequests.push(request);
      if (state.forkImpl) return state.forkImpl(request);
      return Promise.resolve({ ok: true, value: { sessionId: state.nextSideId } });
    },
    create: function (request) {
      state.createRequests.push(request);
      if (state.createImpl) return state.createImpl(request);
      return Promise.resolve({ ok: true, value: { sessionId: state.nextSideId } });
    },
    retain: function (sessionId, retainOptions) {
      const reference = {
        sessionId,
        options: retainOptions,
        release: function () { state.released.push(sessionId); },
      };
      state.retained.push(reference);
      return reference;
    },
    rename: function (sessionId, title) {
      state.renamed.push({ sessionId, title });
      return Promise.resolve();
    },
  };

  const uiWorkspace = {
    get mainReference() { return state.mainReference; },
    workspaces: {
      list: {
        getSnapshot: function () {
          return { items: state.workspaceItems, archivedSessionIds: state.archivedSessionIds };
        },
      },
    },
    unarchiveSession: function (sessionId) {
      state.unarchived.push(sessionId);
      return Promise.resolve();
    },
    archiveSession: function (sessionId) {
      state.archived.push(sessionId);
      return Promise.resolve();
    },
  };

  const locale = {
    register: function (namespace, language, table) {
      state.localeRegistrations.push({ namespace, language, table });
      return function () {};
    },
    bind: function (namespace) {
      return function (key, vars) { return locale.t(namespace, key, vars); };
    },
    t: function (namespace, key, vars) {
      state.localeTCalls.push({ namespace, key, vars });
      if (state.localeTImpl) return state.localeTImpl(namespace, key, vars);
      return undefined;
    },
  };

  const sidebarRightTabs = {
    register: function (definition) {
      state.tabTypes.push(definition);
      return function () { state.disposedTabTypes.push(definition.id); };
    },
  };

  const sidebarRight = {
    openTab: function (kind, tabOptions) { state.openedTabs.push({ kind, options: tabOptions }); },
    close: function (kind) { state.closedTabs.push(kind); },
    commandTarget: function (element) {
      state.commandTargets.push(element);
      return state.commandTargetValue;
    },
    isTargetCurrent: function () { return true; },
    toggleExpanded: function () { state.openedTabs.push({ kind: '__toggle' }); },
    openTabFromTarget: function (kind, target) {
      state.openedTabs.push({ kind, target });
    },
  };

  const layout = {
    openRightbar: function () { state.layoutCalls.push('openRightbar'); },
    closeRightbar: function () { state.layoutCalls.push('closeRightbar'); },
  };

  const shortcuts = {
    register: function (definition) {
      state.shortcutDefs.push(definition);
      return function () { state.disposedShortcuts.push(definition.id); };
    },
  };

  host.services = {
    sessions,
    uiWorkspace,
    locale,
    sidebarRightTabs,
    sidebarRight,
    layout,
    shortcuts,
  };

  const windowListeners = Object.create(null);
  const win = {
    __listeners: windowListeners,
    __ModuleLoader__: {
      load: function (definition) { host.__captured = definition; },
    },
    localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
    innerWidth: 1400,
    innerHeight: 900,
    addEventListener: function (type, fn, listenerOptions) {
      (windowListeners[type] || (windowListeners[type] = [])).push({ fn, options: listenerOptions });
    },
    removeEventListener: function (type, fn) {
      const list = windowListeners[type];
      if (!list) return;
      const index = list.findIndex(function (entry) { return entry.fn === fn; });
      if (index >= 0) list.splice(index, 1);
    },
    requestAnimationFrame: function (callback) {
      state.rafSeq += 1;
      state.rafQueue.set(state.rafSeq, callback);
      return state.rafSeq;
    },
    cancelAnimationFrame: function (id) { state.rafQueue.delete(id); },
    dispatchEvent: function (event) {
      const list = windowListeners[event && event.type] || [];
      for (let i = 0; i < list.length; i += 1) list[i].fn(event);
    },
  };
  host.window = win;

  const document = createDocument(host);
  document.defaultView = win;
  win.document = document;
  host.document = document;

  function MutationObserverStub(callback) {
    this.callback = callback;
    this.connected = false;
    this.observed = null;
  }
  MutationObserverStub.prototype.observe = function (target, observeOptions) {
    this.connected = true;
    this.observed = target;
    this.options = observeOptions;
    state.mutationObservers.push(this);
  };
  MutationObserverStub.prototype.disconnect = function () { this.connected = false; };
  MutationObserverStub.prototype.takeRecords = function () { return []; };
  host.MutationObserver = MutationObserverStub;

  const sandbox = {
    console: {
      log: function () { state.logs.push(Array.prototype.slice.call(arguments)); },
      warn: function () {
        state.warnings.push(Array.prototype.slice.call(arguments).map(String).join(' '));
      },
      error: function () { state.errors.push(Array.prototype.slice.call(arguments).map(String).join(' ')); },
      info: function () {},
      debug: function () {},
    },
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Promise,
    navigator: {
      language: opts.language || 'zh-CN',
      platform: opts.platform || 'Win32',
      userAgent: opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeepSeekHarnessDesktop/0.2.1 Electron/39.0.0',
    },
    document,
    localStorage: win.localStorage,
    window: win,
    MutationObserver: MutationObserverStub,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    performance: { now: function () { return Date.now(); } },
  };
  host.sandbox = sandbox;
  vm.createContext(sandbox);

  const ctx = {
    get: function (name) {
      if (state.getThrows) throw new Error('service lookup failed for ' + name);
      return host.services[name];
    },
    effect: function (fn) {
      const dispose = fn();
      state.effects.push(dispose);
      return function () { if (typeof dispose === 'function') dispose(); };
    },
    inject: function (dependencies, callback) {
      const deps = Array.isArray(dependencies) ? dependencies : [dependencies];
      state.injectRequests.push(deps.slice());
      const ready = deps.every(function (name) {
        return host.services[name] !== undefined && host.services[name] !== null;
      });
      if (ready) return callback(makeScopeCtx(deps));
      state.pendingInjects.push(deps);
      return function () {};
    },
    slots: {
      inject: function (slotName, callback) {
        state.slotInjects.push(slotName);
        callback();
        return function () {};
      },
      register: function (definition, Component) {
        state.slotRegistrations.push({ definition, Component });
        return function () {};
      },
    },
  };

  // Cordis-style injected scope: services are reachable both as properties
  // (scope.shortcuts) and through get() (scope.get('shortcuts')).
  function makeScopeCtx(dependencies) {
    const scope = Object.create(ctx);
    for (let i = 0; i < dependencies.length; i += 1) {
      scope[dependencies[i]] = host.services[dependencies[i]];
    }
    return scope;
  }

  host.ctx = ctx;

  const React = createReactRuntime();
  host.React = React;

  host.load = function () {
    vm.runInContext(readClientSource(), sandbox, { filename: 'client.js' });
    if (!host.__captured || typeof host.__captured.factory !== 'function') {
      throw new Error('client.js did not register through window.__ModuleLoader__');
    }
    host.plugin = host.__captured.factory(function (name) {
      if (name === 'react') return React;
      throw new Error('unexpected require in client module: ' + name);
    });
    return host.plugin;
  };

  host.apply = function () {
    if (!host.plugin) host.load();
    host.plugin.apply(ctx);
    return host;
  };

  host.initialize = function () {
    host.load();
    host.apply();
    return host;
  };

  host.mount = function (Component, props) {
    return React.mount(Component, props);
  };
  host.render = host.mount;

  host.slotRegistration = function (name) {
    return state.slotRegistrations.filter(function (entry) {
      return entry.definition.name === name;
    });
  };

  host.entry = function (name) {
    return host.slotRegistration(name)[0] || null;
  };

  host.tabType = function () { return state.tabTypes[0] || null; };

  host.addSessionRow = function (sessionId, extraAttrs) {
    const row = createElementStub('div');
    row.className = 'session-row';
    row.setAttribute('data-row-key', 'session:' + sessionId);
    if (extraAttrs) {
      Object.keys(extraAttrs).forEach(function (key) { row.setAttribute(key, extraAttrs[key]); });
    }
    host.document.__elements.push(row);
    return row;
  };

  host.addElement = function (definition) {
    const element = createElementStub((definition && definition.tag) || 'div');
    if (definition && definition.id) element.id = definition.id;
    if (definition && definition.className) element.className = definition.className;
    if (definition && definition.textContent !== undefined) element.textContent = definition.textContent;
    if (definition && definition.attrs) {
      Object.keys(definition.attrs).forEach(function (key) {
        element.setAttribute(key, definition.attrs[key]);
      });
    }
    host.document.__elements.push(element);
    return element;
  };

  host.isRowHidden = function (row) {
    if (!row) return false;
    if (row.__removed) return true;
    if (row.hasAttribute('data-assist-hidden')) return true;
    if (row.hasAttribute('hidden')) return true;
    if (row.style && (row.style.display === 'none' || row.style.visibility === 'hidden')) return true;
    const styleAttr = row.getAttribute && row.getAttribute('style');
    if (styleAttr && /display\s*:\s*none/.test(styleAttr)) return true;
    return false;
  };

  host.flushRaf = function () {
    const queue = Array.from(state.rafQueue.entries());
    state.rafQueue.clear();
    for (let i = 0; i < queue.length; i += 1) {
      try { queue[i][1](0); } catch (error) { state.rafErrors = (state.rafErrors || []).concat([error]); }
    }
  };

  host.notifyMutations = function (records) {
    const batch = Array.isArray(records) ? records : [{ type: 'childList', addedNodes: [], removedNodes: [], target: host.document.body }];
    const connected = state.mutationObservers.filter(function (observer) { return observer.connected; });
    for (let i = 0; i < connected.length; i += 1) {
      try { connected[i].callback(batch); } catch (error) { state.observerErrors = (state.observerErrors || []).concat([error]); }
    }
    host.flushRaf();
  };

  host.styleElements = function () {
    return host.document.head.children.filter(function (child) {
      return child && String(child.tag).toLowerCase() === 'style';
    });
  };

  host.flush = async function (turns) {
    const rounds = typeof turns === 'number' ? turns : 12;
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
    host.flushRaf();
  };

  host.dispose = function () {
    const effects = state.effects.slice().reverse();
    for (let i = 0; i < effects.length; i += 1) {
      if (typeof effects[i] === 'function') {
        try { effects[i](); } catch (error) { state.effectErrors = (state.effectErrors || []).concat([error]); }
      }
    }
  };

  host.shortcut = function (id) {
    return state.shortcutDefs.filter(function (definition) { return definition.id === id; })[0] || null;
  };

  host.triggerShortcut = function (id) {
    const definition = host.shortcut(id);
    if (!definition) throw new Error('shortcut not registered: ' + id);
    const result = typeof definition.resolve === 'function' ? definition.resolve({}) : undefined;
    if (result && result.status === 'handled' && typeof result.run === 'function') result.run();
    return result;
  };

  host.windowKeydownListeners = function () {
    return (host.window.__listeners.keydown || []).slice();
  };

  host.dispatchWindowKeydown = function (event) {
    const entries = (host.window.__listeners.keydown || []).slice();
    const synthetic = Object.assign({
      type: 'keydown',
      key: '',
      code: '',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: host.document.body,
      preventDefault: function () {
        synthetic.defaultPrevented = true;
      },
      stopPropagation: function () {
        synthetic.propagationStopped = true;
      },
      stopImmediatePropagation: function () {
        synthetic.immediatePropagationStopped = true;
      },
    }, event || {});
    let handled = false;
    for (let i = 0; i < entries.length; i += 1) {
      try {
        const value = entries[i].fn(synthetic);
        if (value !== false) handled = true;
      } catch (error) {
        state.keydownErrors = (state.keydownErrors || []).concat([error]);
      }
      if (synthetic.immediatePropagationStopped) break;
    }
    return {
      event: synthetic,
      handled,
      capture: entries.map(function (entry) {
        return entry.options === true || !!(entry.options && entry.options.capture);
      }),
    };
  };

  host.dispatchDocumentKeydown = function (event) {
    const list = host.document.__listeners.keydown || [];
    const synthetic = Object.assign({
      type: 'keydown',
      key: '',
      code: '',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      target: host.document.body,
      preventDefault: function () { synthetic.defaultPrevented = true; },
      stopPropagation: function () { synthetic.propagationStopped = true; },
    }, event || {});
    let handled = false;
    for (let i = 0; i < list.length; i += 1) {
      try {
        const value = list[i](synthetic);
        if (value !== false) handled = true;
      } catch (error) {
        state.keydownErrors = (state.keydownErrors || []).concat([error]);
      }
    }
    return { event: synthetic, handled };
  };

  return host;
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function readLocaleFile(language) {
  const file = path.join(__dirname, '..', 'locale', language + '.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function extractLocaleKeys(source) {
  const keys = new Set();
  // Components run their copy through a translator that may be the injected
  // props.t (tr('key')) or the module-level t('key'); accept both spellings.
  const callRe = /(?:^|[^.\w])(?:t|tr)\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = callRe.exec(source)) !== null) keys.add(match[1]);
  return Array.from(keys).sort();
}

function findEmbeddedTable(source, tableName) {
  const startRe = new RegExp('const\\s+' + tableName + '\\s*=\\s*\\{');
  const match = startRe.exec(source);
  if (!match) return null;
  let index = match.index + match[0].length;
  let depth = 1;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    index += 1;
  }
  const body = source.slice(match.index + match[0].length, index - 1);
  const keys = [];
  const entryRe = /['"]([^'"]+)['"]\s*:\s*/g;
  let entry;
  while ((entry = entryRe.exec(body)) !== null) keys.push(entry[1]);
  return { body, keys };
}

module.exports = {
  CLIENT_PATH,
  PLUGIN_ID,
  KIND,
  CONV_SLOT,
  NS,
  readClientSource,
  createHost,
  createReactRuntime,
  readLocaleFile,
  extractLocaleKeys,
  findEmbeddedTable,
  parseSelector,
};
