// Registration suite: plugin contract, tab/guide/header seats, locale bundles,
// slot declarations, style injection and disposal — all against the mocked host.
'use strict';

const h = require('./_harness.cjs');

function textOf(tree) {
  if (tree === null || tree === undefined) return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (typeof tree === 'object') {
    if (typeof tree.children === 'string') return tree.children;
    return textOf(tree.children);
  }
  return '';
}

function findByType(tree, type) {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) {
    for (let i = 0; i < tree.length; i += 1) {
      const found = findByType(tree[i], type);
      if (found) return found;
    }
    return null;
  }
  if (tree.type === type) return tree;
  return findByType(tree.children, type);
}

function tabLikeProps(translator, parentSessionId) {
  return {
    sessionId: '',
    t: translator,
    useTabInfo: function () {
      return { tab: { navigation: { params: parentSessionId ? { parent: parentSessionId } : null } } };
    },
    renderSlot: function (name, slotProps) { return { type: 'slot', name, props: slotProps }; },
    SessionProvider: function SessionProvider() {},
  };
}

function conversationLikeProps(translator) {
  return {
    sessionId: 'side-1',
    t: translator,
    useSession: function (selector) {
      return selector({ blank: true, running: false, awaitingFirstTurn: false, openState: 'open', promptAttempted: false });
    },
    useConversation: function (selector) { return selector({ activeTargets: new Set() }); },
    useSessions: function (selector) { return selector({ byId: { 'side-1': { blank: true } } }); },
  };
}

module.exports.run = async function run(ok) {
  const host = h.createHost();
  let loadError = null;
  try {
    host.initialize();
  } catch (error) {
    loadError = error;
  }
  ok('registration: module loads and apply() completes', !loadError, loadError && (loadError.message + '\n' + loadError.stack));
  if (loadError) return;

  const state = host.state;
  const plugin = host.plugin;

  /* ---------------- plugin contract ---------------- */
  ok('registration: factory returns a plugin object', !!plugin && typeof plugin.apply === 'function');
  ok('registration: plugin declares an inject list', Array.isArray(plugin.inject), JSON.stringify(plugin.inject));
  ok('registration: injects the slots service first', Array.isArray(plugin.inject) && plugin.inject[0] === 'slots', JSON.stringify(plugin.inject));
  ok('registration: inject list has no duplicates', Array.isArray(plugin.inject) && new Set(plugin.inject).size === plugin.inject.length);
  ok('registration: factory id is the package name', host.__captured && host.__captured.id === h.PLUGIN_ID, host.__captured && host.__captured.id);

  /* ---------------- locale bundles ---------------- */
  const localeRegs = state.localeRegistrations;
  const languages = localeRegs.map(function (entry) { return entry.language; }).sort();
  ok('registration: registers both zh and en locale bundles', languages.join(',') === 'en,zh', JSON.stringify(languages));
  ok('registration: locale bundles use the plugin namespace', localeRegs.length > 0 && localeRegs.every(function (entry) { return entry.namespace === h.NS; }),
    JSON.stringify(localeRegs.map(function (entry) { return entry.namespace; })));
  const registeredKeys = localeRegs.map(function (entry) { return Object.keys(entry.table || {}).sort(); });
  ok('registration: zh and en locale bundles expose the same keys',
    registeredKeys.length === 2 && JSON.stringify(registeredKeys[0]) === JSON.stringify(registeredKeys[1]),
    JSON.stringify(registeredKeys));

  /* ---------------- tab type + guide ---------------- */
  ok('registration: registers exactly one sidebar tab type', state.tabTypes.length === 1, String(state.tabTypes.length));
  const tab = host.tabType() || {};
  ok('registration: tab type id is the package name', tab.id === h.PLUGIN_ID, tab.id);
  ok('registration: tab type kind is assistchat', tab.kind === h.KIND, tab.kind);
  ok('registration: tab type priority is extension', tab.priority === 'extension', tab.priority);
  ok('registration: tab type keeps the seat mounted', tab.keepMounted === true, String(tab.keepMounted));
  ok('registration: tab title is a locale function', typeof tab.title === 'function');
  ok('registration: tab type ships exactly one guide card', Array.isArray(tab.guide) && tab.guide.length === 1,
    JSON.stringify(tab.guide && tab.guide.length));
  const guide = (tab.guide || [])[0] || {};
  ok('registration: guide card has a stable id', typeof guide.id === 'string' && guide.id !== '', String(guide.id));
  ok('registration: guide card has a numeric order', typeof guide.order === 'number' && isFinite(guide.order), String(guide.order));
  ok('registration: guide card title is a locale function', typeof guide.title === 'function');
  ok('registration: guide card description is a locale function', typeof guide.description === 'function');
  ok('registration: guide card icon is a component', typeof guide.icon === 'function');
  if (typeof guide.icon === 'function') {
    const iconTree = host.render(guide.icon, {}).tree;
    ok('registration: guide card icon renders an svg glyph', !!iconTree && iconTree.type === 'svg', iconTree && String(iconTree.type));
    ok('registration: guide card icon draws the chat bubble paths', !!iconTree && Array.isArray(iconTree.children) && iconTree.children.length >= 2,
      iconTree && String(iconTree.children && iconTree.children.length));
  }

  /* ---------------- slot registrations ---------------- */
  const expectedSlots = [
    'conversation.session.header.actions',
    'sidebar.assist.conversation',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
  ].sort();
  const slotNames = state.slotRegistrations.map(function (entry) { return entry.definition.name; }).sort();
  ok('registration: registers the four visible seats', JSON.stringify(slotNames) === JSON.stringify(expectedSlots), JSON.stringify(slotNames));
  ok('registration: injects into all four slot surfaces',
    JSON.stringify(state.slotInjects.slice().sort()) === JSON.stringify(expectedSlots), JSON.stringify(state.slotInjects));
  ok('registration: every seat opts into the locale-bound translator',
    state.slotRegistrations.length === 4 && state.slotRegistrations.every(function (entry) { return entry.definition.locale === h.NS; }),
    JSON.stringify(state.slotRegistrations.map(function (entry) { return entry.definition.locale; })));

  const paneEntry = host.entry('sidebar.right.pane.tab');
  ok('registration: pane tab seat is keyed by the implementation id', !!paneEntry && paneEntry.definition.key === h.PLUGIN_ID,
    paneEntry && paneEntry.definition.key);
  const paneChildren = paneEntry && paneEntry.definition.children;
  ok('registration: pane tab declares the embedded conversation child slot', !!paneChildren && !!paneChildren[h.CONV_SLOT],
    JSON.stringify(paneChildren));
  const convChild = paneChildren && paneChildren[h.CONV_SLOT];
  ok('registration: conversation child slot is single + session scoped',
    !!convChild && convChild.kind === 'single' && convChild.scope === 'session', JSON.stringify(convChild));

  const headerEntry = host.entry('conversation.session.header.actions');
  ok('registration: header seat carries the assist-chat-open id', !!headerEntry && headerEntry.definition.id === 'assist-chat-open',
    headerEntry && headerEntry.definition.id);
  ok('registration: header seat order is 60', !!headerEntry && headerEntry.definition.order === 60,
    headerEntry && headerEntry.definition.order);

  const titleEntry = host.entry('sidebar.right.pane.tab.title');
  ok('registration: tab-title seat is keyed by the implementation id', !!titleEntry && titleEntry.definition.key === h.PLUGIN_ID,
    titleEntry && titleEntry.definition.key);
  const titleTree = titleEntry ? host.render(titleEntry.Component, {}).tree : null;
  ok('registration: tab-title seat renders the tab label', !!titleTree && textOf(titleTree) === '辅助对话', textOf(titleTree));

  /* ---------------- injected styles ---------------- */
  const styles = host.styleElements();
  ok('registration: injects at least one style element', styles.length >= 1, String(styles.length));
  const mainStyles = styles.filter(function (element) {
    return element.getAttribute('data-plugin') === h.PLUGIN_ID;
  });
  ok('registration: injects exactly one main stylesheet', mainStyles.length === 1, String(mainStyles.length));
  if (mainStyles.length > 0) {
    const css = String(mainStyles[0].textContent || '');
    ok('registration: stylesheet covers the seat root', css.indexOf('.dac-root') >= 0, css.slice(0, 80));
    ok('registration: stylesheet covers the header button', css.indexOf('.dac-header-btn') >= 0);
    ok('registration: stylesheet covers the status shell', css.indexOf('.dac-status') >= 0);
  }
  ok('registration: every injected style element is labelled', styles.every(function (element) { return !!element.getAttribute('data-plugin'); }));

  /* ---------------- default (zh) copy ---------------- */
  ok('registration: tab title falls back to Simplified Chinese', typeof tab.title === 'function' && tab.title() === '辅助对话', typeof tab.title === 'function' ? tab.title() : 'n/a');
  ok('registration: guide title falls back to Simplified Chinese', typeof guide.title === 'function' && guide.title() === '辅助对话');
  ok('registration: guide description falls back to Simplified Chinese', typeof guide.description === 'function' && guide.description().indexOf('旁支会话') >= 0);

  const headerView = host.render(headerEntry.Component, {});
  const headerTree = headerView.tree;
  ok('registration: header seat renders a button', !!headerTree && headerTree.type === 'button', headerTree && String(headerTree.type));
  if (headerTree) {
    ok('registration: header button carries the dac-header-btn class', headerTree.props.className === 'dac-header-btn', headerTree.props.className);
    ok('registration: header button title falls back to Simplified Chinese', headerTree.props.title === '在右侧栏开启辅助对话', headerTree.props.title);
    ok('registration: header button aria-label matches its title', headerTree.props['aria-label'] === headerTree.props.title);
    const headerText = textOf(headerTree);
    ok('registration: header button shows the localized label', headerText.indexOf('辅助对话') >= 0, headerText);
    ok('registration: header button renders the glyph plus a label', Array.isArray(headerTree.children) && headerTree.children.length === 2,
      headerTree.children && String(headerTree.children.length));
    const glyphChild = Array.isArray(headerTree.children) ? headerTree.children[0] : null;
    ok('registration: header button embeds the guide glyph component', !!glyphChild && glyphChild.type === guide.icon,
      glyphChild && String(glyphChild.type));
  }

  /* ---------------- header click opens the seat ---------------- */
  const event = { prevented: false, stopped: false, preventDefault: function () { event.prevented = true; }, stopPropagation: function () { event.stopped = true; } };
  let clickError = null;
  try {
    headerTree.props.onClick(event);
  } catch (error) {
    clickError = error;
  }
  ok('registration: header click does not throw', !clickError, clickError && clickError.message);
  ok('registration: header click consumes the event', event.prevented === true && event.stopped === true);
  ok('registration: header click opens the assist-chat tab', state.openedTabs.length === 1 && state.openedTabs[0].kind === h.KIND,
    JSON.stringify(state.openedTabs));
  const openOptions = state.openedTabs[0] && state.openedTabs[0].options;
  ok('registration: header click passes the current main session as a tab param',
    !!openOptions && !!openOptions.params && openOptions.params.parent === 'main-1', JSON.stringify(openOptions));

  /* ---------------- localized copy through the locale service ---------------- */
  const localized = h.createHost();
  localized.state.localeTImpl = function (namespace, key) { return 'L(' + key + ')'; };
  let localizedError = null;
  try {
    localized.initialize();
  } catch (error) {
    localizedError = error;
  }
  ok('registration: apply() with a live locale service completes', !localizedError, localizedError && localizedError.message);
  if (!localizedError) {
    const localizedTab = localized.tabType();
    ok('registration: tab title delegates to the locale service', localizedTab.title() === 'L(tab.title)', localizedTab.title());
    ok('registration: guide title delegates to the locale service', localizedTab.guide[0].title() === 'L(guide.title)');
    ok('registration: guide description delegates to the locale service', localizedTab.guide[0].description() === 'L(guide.description)');
    const localizedHeader = localized.render(localized.entry('conversation.session.header.actions').Component, {}).tree;
    ok('registration: header button label delegates to the locale service', textOf(localizedHeader) === 'L(header.button)', textOf(localizedHeader));
    ok('registration: header button title delegates to the locale service', localizedHeader.props.title === 'L(header.buttonTitle)', localizedHeader.props.title);
  }

  /* ---------------- injected reactive translator (props.t) ---------------- */
  const injected = function (key) { return 'E(' + key + ')'; };
  const injectedHeader = host.render(host.entry('conversation.session.header.actions').Component, { t: injected }).tree;
  ok('registration: header seat prefers the injected props.t', textOf(injectedHeader) === 'E(header.button)', textOf(injectedHeader));
  ok('registration: header seat title prefers the injected props.t', injectedHeader.props.title === 'E(header.buttonTitle)', injectedHeader.props.title);
  const injectedTitle = host.render(host.entry('sidebar.right.pane.tab.title').Component, { t: injected }).tree;
  ok('registration: tab-title seat prefers the injected props.t', textOf(injectedTitle) === 'E(tab.title)', textOf(injectedTitle));
  const injectedConversation = host.render(host.entry(h.CONV_SLOT).Component, conversationLikeProps(injected)).tree;
  ok('registration: conversation seat prefers the injected props.t', textOf(injectedConversation) === 'E(status.error)', textOf(injectedConversation));
  const injectedTabView = host.mount(host.entry('sidebar.right.pane.tab').Component, tabLikeProps(injected, 'main-1'));
  ok('registration: tab seat prefers the injected props.t', textOf(injectedTabView.tree).indexOf('E(status.creating)') >= 0, textOf(injectedTabView.tree));
  injectedTabView.unmount();
  await host.flush();

  /* ---------------- English UI + live locale switching ---------------- */
  const zhFile = h.readLocaleFile('zh');
  const enFile = h.readLocaleFile('en');
  const switching = h.createHost();
  switching.state.language = 'zh';
  switching.state.localeTImpl = function (namespace, key) {
    return switching.state.language === 'en' ? enFile[key] : zhFile[key];
  };
  switching.initialize();
  ok('registration: zh locale resolves the tab title from the packaged bundle',
    switching.tabType().title() === '辅助对话', switching.tabType().title());
  switching.state.language = 'en';
  ok('registration: a live locale switch immediately relabels the tab',
    switching.tabType().title() === 'Side chat', switching.tabType().title());
  const enGuide = switching.tabType().guide[0];
  ok('registration: a live locale switch relabels the guide title', enGuide.title() === 'Side chat', enGuide.title());
  ok('registration: a live locale switch relabels the guide description',
    enGuide.description() === enFile['guide.description'], enGuide.description());
  const enHeader = switching.render(switching.entry('conversation.session.header.actions').Component, {}).tree;
  ok('registration: english header label', textOf(enHeader) === 'Side chat', textOf(enHeader));
  ok('registration: english header title', enHeader.props.title === 'Open side chat in the right sidebar', enHeader.props.title);
  const enTitle = switching.render(switching.entry('sidebar.right.pane.tab.title').Component, {}).tree;
  ok('registration: english tab-chip label', textOf(enTitle) === 'Side chat', textOf(enTitle));
  switching.state.language = 'zh';
  ok('registration: switching back restores the Chinese tab title',
    switching.tabType().title() === '辅助对话', switching.tabType().title());
  switching.dispose();

  /* legacy locale services without bind() keep working, without the slot option */
  const legacy = h.createHost();
  legacy.services.locale = {
    register: function () {},
    t: function (namespace, key) { return key === 'tab.title' ? 'LEGACY-TAB' : undefined; },
  };
  legacy.initialize();
  ok('registration: hosts without bind() omit the locale slot option',
    legacy.state.slotRegistrations.length === 4
    && legacy.state.slotRegistrations.every(function (entry) { return entry.definition.locale === undefined; }),
    JSON.stringify(legacy.state.slotRegistrations.map(function (entry) { return entry.definition.locale; })));
  ok('registration: legacy t(ns,key) services are still honoured', legacy.tabType().title() === 'LEGACY-TAB', legacy.tabType().title());
  legacy.dispose();

  /* bind(ns) must win over legacy t()/translate(): the shipped service has no t() */
  const bindOnly = h.createHost();
  let bindLanguage = 'zh';
  bindOnly.services.locale = {
    register: function () {},
    bind: function (namespace) {
      return function (key) {
        if (namespace !== h.NS) return undefined;
        return (bindLanguage === 'en' ? enFile : zhFile)[key];
      };
    },
  };
  bindOnly.initialize();
  ok('registration: bind(ns) is preferred over legacy t()/translate()',
    bindOnly.tabType().title() === '辅助对话', bindOnly.tabType().title());
  bindLanguage = 'en';
  ok('registration: the bound translator re-reads the active locale on every call',
    bindOnly.tabType().title() === 'Side chat', bindOnly.tabType().title());
  bindOnly.dispose();

  /* ---------------- disposal ---------------- */
  let disposeError = null;
  try {
    host.dispose();
  } catch (error) {
    disposeError = error;
  }
  ok('registration: disposal completes without throwing', !disposeError, disposeError && disposeError.message);
  ok('registration: disposal unregisters the tab type', state.disposedTabTypes.indexOf(h.PLUGIN_ID) >= 0, JSON.stringify(state.disposedTabTypes));
  ok('registration: disposal removes the injected stylesheets', host.styleElements().every(function (element) { return element.__removed === true; }),
    JSON.stringify(host.styleElements().map(function (element) { return element.__removed; })));
  ok('registration: disposal disconnects the catalog observer', state.mutationObservers.every(function (observer) { return observer.connected === false; }),
    JSON.stringify(state.mutationObservers.map(function (observer) { return observer.connected; })));
};
