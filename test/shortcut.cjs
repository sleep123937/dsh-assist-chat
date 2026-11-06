// Shortcut suite: the Ctrl+Shift+B command registration (desktop profile), the
// always-on capture-phase keydown fallback, blocked handling without a main
// session, the 250ms double-trigger guard and cleanup.
'use strict';

const h = require('./_harness.cjs');

const SHORTCUT_ID = 'dsh-assist-chat.open';

function press(host, overrides) {
  return host.dispatchWindowKeydown(Object.assign({ code: 'KeyB', key: 'b', ctrlKey: true, shiftKey: true }, overrides || {}));
}

module.exports.run = async function run(ok) {
  /* ---------------- A: shortcuts-service registration ---------------- */
  const host = h.createHost();
  host.initialize();

  ok('shortcut: apply() asks for the shortcuts service through ctx.inject',
    host.state.injectRequests.some(function (deps) { return deps.indexOf('shortcuts') >= 0; }),
    JSON.stringify(host.state.injectRequests));
  ok('shortcut: exactly one shortcut command is registered', host.state.shortcutDefs.length === 1, String(host.state.shortcutDefs.length));

  const def = host.state.shortcutDefs[0] || {};
  ok('shortcut: command id is dsh-assist-chat.open', def.id === SHORTCUT_ID, def.id);
  ok('shortcut: command label is a locale function', typeof def.label === 'function');
  ok('shortcut: command label falls back to Simplified Chinese', typeof def.label === 'function' && def.label() === '打开辅助对话',
    typeof def.label === 'function' ? def.label() : 'n/a');
  ok('shortcut: command ships search aliases', Array.isArray(def.aliases) && def.aliases.length > 0
    && def.aliases.every(function (alias) { return typeof alias === 'string'; }), JSON.stringify(def.aliases));
  const defaults = def.defaults || {};
  const desktopProfiles = ['desktop:macos', 'desktop:windows', 'desktop:linux'];
  ok('shortcut: command declares stable desktop bindings',
    desktopProfiles.every(function (profile) { return !!defaults[profile]; }), JSON.stringify(Object.keys(defaults)));
  ok('shortcut: desktop bindings are Ctrl+Shift+B',
    desktopProfiles.every(function (profile) {
      const binding = defaults[profile] || {};
      return binding.code === 'KeyB' && Array.isArray(binding.modifiers)
        && binding.modifiers.indexOf('primary') >= 0 && binding.modifiers.indexOf('shift') >= 0;
    }), JSON.stringify(defaults));
  ok('shortcut: web profiles stay untouched so the host shortcut is not stolen',
    Object.keys(defaults).every(function (profile) { return profile.indexOf('web:') !== 0; }), JSON.stringify(Object.keys(defaults)));
  ok('shortcut: command declares the page/edit/terminal regions',
    Array.isArray(def.regions) && def.regions.indexOf('page') >= 0 && def.regions.indexOf('editable') >= 0 && def.regions.indexOf('terminal') >= 0,
    JSON.stringify(def.regions));
  ok('shortcut: command declares an empty modal allow-list', Array.isArray(def.modals) && def.modals.length === 0, JSON.stringify(def.modals));
  ok('shortcut: command resolves through a function', typeof def.resolve === 'function');

  const handled = def.resolve ? def.resolve({}) : null;
  ok('shortcut: resolve reports handled with a main session',
    !!handled && handled.status === 'handled' && typeof handled.run === 'function', JSON.stringify(handled && handled.status));
  let runError = null;
  try {
    if (handled && typeof handled.run === 'function') handled.run();
  } catch (error) {
    runError = error;
  }
  ok('shortcut: resolve.run does not throw', !runError, runError && runError.message);
  ok('shortcut: resolve.run opens (or reveals) the assist-chat tab',
    host.state.openedTabs.length === 1 && host.state.openedTabs[0].kind === h.KIND, JSON.stringify(host.state.openedTabs));
  ok('shortcut: resolve.run passes the current main session as a tab param',
    !!host.state.openedTabs[0] && !!host.state.openedTabs[0].options && !!host.state.openedTabs[0].options.params
    && host.state.openedTabs[0].options.params.parent === 'main-1', JSON.stringify(host.state.openedTabs[0]));

  /* blocked without a main session */
  const blockedHost = h.createHost();
  blockedHost.state.mainReference = null;
  blockedHost.initialize();
  const blockedDef = blockedHost.state.shortcutDefs[0] || {};
  const blocked = typeof blockedDef.resolve === 'function' ? blockedDef.resolve({}) : null;
  ok('shortcut: resolve is blocked without a main session', !!blocked && blocked.status === 'blocked', JSON.stringify(blocked && blocked.status));
  ok('shortcut: blocked resolve explains why in the user locale',
    !!blocked && blocked.reason === '当前没有可用的主对话', blocked && JSON.stringify(blocked.reason));
  ok('shortcut: blocked resolve does not open a tab', blockedHost.state.openedTabs.length === 0, JSON.stringify(blockedHost.state.openedTabs));

  /* disposal */
  host.dispose();
  ok('shortcut: disposal unregisters the shortcut command', host.state.disposedShortcuts.indexOf(SHORTCUT_ID) >= 0,
    JSON.stringify(host.state.disposedShortcuts));

  /* ---------------- B: always-on capture keydown fallback ---------------- */
  const domHost = h.createHost();
  domHost.services.shortcuts = undefined;
  domHost.initialize();
  const listeners = domHost.windowKeydownListeners();
  ok('shortcut: a window keydown fallback is always installed', listeners.length === 1, String(listeners.length));
  ok('shortcut: the keydown fallback listens in the capture phase',
    listeners.length === 1 && (listeners[0].options === true || !!(listeners[0].options && listeners[0].options.capture)),
    JSON.stringify(listeners.map(function (entry) { return entry.options; })));

  const pressed = press(domHost);
  ok('shortcut: Ctrl+Shift+B opens the assist-chat tab through the fallback',
    domHost.state.openedTabs.length === 1 && domHost.state.openedTabs[0].kind === h.KIND, JSON.stringify(domHost.state.openedTabs));
  ok('shortcut: the fallback opens the tab for the current main session',
    !!domHost.state.openedTabs[0] && !!domHost.state.openedTabs[0].options && !!domHost.state.openedTabs[0].options.params
    && domHost.state.openedTabs[0].options.params.parent === 'main-1');
  ok('shortcut: the fallback consumes the keydown', pressed.event.defaultPrevented === true,
    JSON.stringify({ prevented: pressed.event.defaultPrevented }));
  ok('shortcut: the fallback stops further propagation',
    pressed.event.immediatePropagationStopped === true || pressed.event.propagationStopped === true,
    JSON.stringify({ immediate: pressed.event.immediatePropagationStopped, plain: pressed.event.propagationStopped }));

  /* negative matches (fresh host each time: the fallback state is per module) */
  const negatives = [
    { label: 'without shift', event: { code: 'KeyB', ctrlKey: true } },
    { label: 'with alt', event: { code: 'KeyB', ctrlKey: true, shiftKey: true, altKey: true } },
    { label: 'while the key repeats', event: { code: 'KeyB', ctrlKey: true, shiftKey: true, repeat: true } },
    { label: 'while composing text', event: { code: 'KeyB', ctrlKey: true, shiftKey: true, isComposing: true } },
    { label: 'after the event was already handled', event: { code: 'KeyB', ctrlKey: true, shiftKey: true, defaultPrevented: true }, alreadyPrevented: true },
    { label: 'for another key', event: { code: 'KeyX', ctrlKey: true, shiftKey: true } },
    { label: 'without any primary modifier', event: { code: 'KeyB', shiftKey: true } },
  ];
  for (let i = 0; i < negatives.length; i += 1) {
    const negative = negatives[i];
    const negativeHost = h.createHost();
    negativeHost.services.shortcuts = undefined;
    negativeHost.initialize();
    const result = negativeHost.dispatchWindowKeydown(Object.assign({
      code: 'KeyB', key: 'b', ctrlKey: false, shiftKey: false,
    }, negative.event));
    ok('shortcut: fallback ignores Ctrl+Shift+B ' + negative.label,
      negativeHost.state.openedTabs.length === 0 && (negative.alreadyPrevented === true || result.event.defaultPrevented === false),
      JSON.stringify({ tabs: negativeHost.state.openedTabs.length, prevented: result.event.defaultPrevented }));
  }

  /* meta (macOS primary) is accepted */
  const metaHost = h.createHost();
  metaHost.services.shortcuts = undefined;
  metaHost.initialize();
  metaHost.dispatchWindowKeydown({ code: 'KeyB', key: 'b', metaKey: true, shiftKey: true });
  ok('shortcut: the fallback accepts the meta primary modifier', metaHost.state.openedTabs.length === 1,
    JSON.stringify(metaHost.state.openedTabs));

  /* no main session: do not consume the host shortcut */
  const noMainHost = h.createHost();
  noMainHost.services.shortcuts = undefined;
  noMainHost.state.mainReference = null;
  noMainHost.initialize();
  const noMainPress = press(noMainHost);
  ok('shortcut: the fallback opens nothing without a main session', noMainHost.state.openedTabs.length === 0,
    JSON.stringify(noMainHost.state.openedTabs));
  ok('shortcut: the fallback leaves Ctrl+Shift+B to the host without a main session',
    noMainPress.event.defaultPrevented === false && !noMainPress.event.propagationStopped && !noMainPress.event.immediatePropagationStopped,
    JSON.stringify({ prevented: noMainPress.event.defaultPrevented, stopped: noMainPress.event.propagationStopped }));

  /* the DOM fallback also works when the shortcut service did register the command */
  const dualHost = h.createHost();
  dualHost.initialize();
  const dualPress = press(dualHost);
  ok('shortcut: the keydown fallback works alongside the registered command',
    dualHost.state.openedTabs.length === 1 && dualPress.event.defaultPrevented === true,
    JSON.stringify(dualHost.state.openedTabs));

  /* a modal owns the keyboard: never steal the chord from a dialog */
  const modalHost = h.createHost();
  modalHost.services.shortcuts = undefined;
  modalHost.initialize();
  const modalPress = modalHost.dispatchWindowKeydown({
    code: 'KeyB',
    key: 'b',
    ctrlKey: true,
    shiftKey: true,
    target: { closest: function (selector) { return String(selector).indexOf('[role="dialog"]') >= 0 ? {} : null; } },
  });
  ok('shortcut: the fallback leaves the chord alone while a dialog is open',
    modalHost.state.openedTabs.length === 0 && modalPress.event.defaultPrevented === false,
    JSON.stringify({ tabs: modalHost.state.openedTabs.length, prevented: modalPress.event.defaultPrevented }));

  /* ---------------- C: double-trigger guard ---------------- */
  const guardHost = h.createHost();
  guardHost.services.shortcuts = undefined;
  guardHost.initialize();
  press(guardHost);
  press(guardHost);
  ok('shortcut: a duplicated Ctrl+Shift+B within the debounce window opens the tab once',
    guardHost.state.openedTabs.length === 1, String(guardHost.state.openedTabs.length));
  await new Promise(function (resolve) { setTimeout(resolve, 320); });
  press(guardHost);
  ok('shortcut: Ctrl+Shift+B works again after the debounce window',
    guardHost.state.openedTabs.length === 2, String(guardHost.state.openedTabs.length));

  /* ---------------- D: registration failure keeps the fallback healthy ---------------- */
  const failing = h.createHost();
  failing.services.shortcuts.register = function () { throw new Error('binding conflict'); };
  let failingError = null;
  try {
    failing.initialize();
  } catch (error) {
    failingError = error;
  }
  ok('shortcut: a throwing shortcut registry does not break apply()', !failingError, failingError && failingError.message);
  ok('shortcut: a throwing shortcut registry is reported as a warning',
    failing.state.warnings.some(function (line) { return line.toLowerCase().indexOf('shortcut') >= 0; }), JSON.stringify(failing.state.warnings));
  press(failing);
  ok('shortcut: the fallback still works after a registration failure', failing.state.openedTabs.length === 1,
    JSON.stringify(failing.state.openedTabs));
  failing.dispose();
  ok('shortcut: disposal removes the keydown fallback listener', failing.windowKeydownListeners().length === 0,
    String(failing.windowKeydownListeners().length));

  /* ---------------- E: ctx.get path when ctx.inject is unavailable ---------------- */
  const getPath = h.createHost();
  getPath.ctx.inject = undefined;
  getPath.initialize();
  ok('shortcut: without ctx.inject the command is registered through ctx.get',
    getPath.state.shortcutDefs.length === 1 && getPath.state.shortcutDefs[0].id === SHORTCUT_ID,
    JSON.stringify(getPath.state.shortcutDefs.map(function (entry) { return entry.id; })));
  ok('shortcut: the keydown fallback is installed on the ctx.get path too',
    getPath.windowKeydownListeners().length === 1, String(getPath.windowKeydownListeners().length));
  press(getPath);
  ok('shortcut: the ctx.get path can open the seat', getPath.state.openedTabs.length === 1,
    JSON.stringify(getPath.state.openedTabs));
  getPath.dispose();

  /* no shortcut service and no ctx.inject: pure DOM fallback */
  const bare = h.createHost();
  bare.services.shortcuts = undefined;
  bare.ctx.inject = undefined;
  let bareError = null;
  try {
    bare.initialize();
  } catch (error) {
    bareError = error;
  }
  ok('shortcut: apply() survives without any shortcut surface', !bareError, bareError && bareError.message);
  ok('shortcut: the DOM fallback is installed without any shortcut surface', bare.windowKeydownListeners().length === 1,
    String(bare.windowKeydownListeners().length));
  press(bare);
  ok('shortcut: the DOM fallback still opens the seat', bare.state.openedTabs.length === 1, JSON.stringify(bare.state.openedTabs));

  /* ---------------- F: locale keys ---------------- */
  const localized = h.createHost();
  localized.state.localeTImpl = function (namespace, key) { return 'L(' + key + ')'; };
  localized.initialize();
  const localizedDef = localized.state.shortcutDefs[0];
  ok('shortcut: the command label delegates to the locale service', localizedDef.label() === 'L(shortcut.open)', localizedDef.label());
  localized.state.mainReference = null;
  const localizedBlocked = localizedDef.resolve({});
  ok('shortcut: the blocked reason delegates to the locale service',
    !!localizedBlocked && localizedBlocked.reason === 'L(shortcut.noSession)', localizedBlocked && localizedBlocked.reason);
};
