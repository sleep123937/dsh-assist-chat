// Error-path suite: the plugin must degrade quietly when host services or the
// main session are missing, when host calls throw, and when the fork/create
// chain fails. Nothing here may raise an uncaught error.
'use strict';

const h = require('./_harness.cjs');

function textOf(tree) {
  if (tree === null || tree === undefined) return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (typeof tree === 'object') return textOf(tree.children);
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

function tabProps(parentSessionId, overrides) {
  const props = {
    sessionId: '',
    useTabInfo: function () {
      return { tab: { navigation: { params: parentSessionId ? { parent: parentSessionId } : null } } };
    },
    renderSlot: function (name, slotProps) { return { type: 'slot', name, props: slotProps }; },
    SessionProvider: function SessionProvider() {},
  };
  return Object.assign(props, overrides || {});
}

function conversationProps(overrides) {
  const props = {
    sessionId: 'side-1',
    useSession: function (selector) {
      return selector({ blank: true, running: false, awaitingFirstTurn: false, openState: 'open', promptAttempted: false });
    },
    useConversation: function (selector) { return selector({ activeTargets: new Set() }); },
    useSessions: function (selector) { return selector({ byId: { 'side-1': { blank: true } } }); },
    renderFactorySlot: function (factory, slotProps, extra) { return { type: 'factory', factory, props: slotProps, extra }; },
  };
  return Object.assign(props, overrides || {});
}

function tabComponent(host) {
  return host.entry('sidebar.right.pane.tab').Component;
}

function headerComponent(host) {
  return host.entry('conversation.session.header.actions').Component;
}

module.exports.run = async function run(ok) {
  /* ---------------- A: apply() without any host service ---------------- */
  const bare = h.createHost();
  bare.services = {};
  let bareError = null;
  try {
    bare.initialize();
  } catch (error) {
    bareError = error;
  }
  ok('errors: apply() tolerates every host service being unavailable', !bareError, bareError && (bareError.message + '\n' + bareError.stack));
  ok('errors: the four seats still register without host services', bare.state.slotRegistrations.length === 4,
    String(bare.state.slotRegistrations.length));
  ok('errors: seats register without the locale option when the locale service is absent',
    bare.state.slotRegistrations.every(function (entry) { return entry.definition.locale === undefined; }),
    JSON.stringify(bare.state.slotRegistrations.map(function (entry) { return entry.definition.locale; })));
  ok('errors: no tab type is claimed without the tab registry', bare.state.tabTypes.length === 0, String(bare.state.tabTypes.length));
  ok('errors: missing host services are reported as warnings', bare.state.warnings.length > 0, JSON.stringify(bare.state.warnings));

  /* ---------------- B: ctx.get() itself throws ---------------- */
  const throwingGet = h.createHost();
  throwingGet.state.getThrows = true;
  let throwingError = null;
  try {
    throwingGet.initialize();
  } catch (error) {
    throwingError = error;
  }
  ok('errors: apply() survives a throwing service lookup', !throwingError, throwingError && throwingError.message);
  ok('errors: seats still register when service lookups throw', throwingGet.state.slotRegistrations.length === 4);

  /* ---------------- C: header click without a main session ---------------- */
  const noMain = h.createHost();
  noMain.state.mainReference = null;
  noMain.initialize();
  const noMainHeader = noMain.render(headerComponent(noMain), {}).tree;
  let noMainClickError = null;
  try {
    noMainHeader.props.onClick(null);
  } catch (error) {
    noMainClickError = error;
  }
  ok('errors: header click without a main session does not throw', !noMainClickError, noMainClickError && noMainClickError.message);
  ok('errors: header click without a main session still opens the seat',
    noMain.state.openedTabs.length === 1 && noMain.state.openedTabs[0].kind === h.KIND, JSON.stringify(noMain.state.openedTabs));
  ok('errors: header click without a main session sends no parent param',
    noMain.state.openedTabs[0] && noMain.state.openedTabs[0].options === undefined, JSON.stringify(noMain.state.openedTabs[0]));
  ok('errors: header click accepts a missing event object', !noMainClickError);

  /* ---------------- D: header click without sidebarRight ---------------- */
  const noSidebar = h.createHost();
  noSidebar.services.sidebarRight = undefined;
  noSidebar.initialize();
  const noSidebarHeader = noSidebar.render(headerComponent(noSidebar), {}).tree;
  let noSidebarClickError = null;
  try {
    noSidebarHeader.props.onClick(null);
  } catch (error) {
    noSidebarClickError = error;
  }
  ok('errors: header click without sidebarRight does not throw', !noSidebarClickError, noSidebarClickError && noSidebarClickError.message);
  ok('errors: header click without sidebarRight is reported as a warning',
    noSidebar.state.warnings.some(function (line) { return line.toLowerCase().indexOf('sidebarright') >= 0; }), JSON.stringify(noSidebar.state.warnings));

  /* ---------------- E: openTab throws -> layout fallback ---------------- */
  const brokenTab = h.createHost();
  brokenTab.services.sidebarRight.openTab = function () { throw new Error('openTab exploded'); };
  brokenTab.initialize();
  const brokenHeader = brokenTab.render(headerComponent(brokenTab), {}).tree;
  let brokenClickError = null;
  try {
    brokenHeader.props.onClick(null);
  } catch (error) {
    brokenClickError = error;
  }
  ok('errors: a throwing openTab does not throw out of the header click', !brokenClickError, brokenClickError && brokenClickError.message);
  ok('errors: a throwing openTab falls back to revealing the right dock', brokenTab.state.layoutCalls.indexOf('openRightbar') >= 0,
    JSON.stringify(brokenTab.state.layoutCalls));

  /* ---------------- F: tab seat without the sessions service ---------------- */
  const noSessions = h.createHost();
  const savedSessions = noSessions.services.sessions;
  noSessions.services.sessions = undefined;
  noSessions.initialize();
  const noSessionsView = noSessions.mount(tabComponent(noSessions), tabProps('main-1'));
  await noSessions.flush();
  ok('errors: a seat without the sessions service shows the error status',
    !!noSessionsView.tree && noSessionsView.tree.props.className === 'dac-status', noSessionsView.tree && JSON.stringify(noSessionsView.tree.props));
  ok('errors: the error status uses the localized error copy', textOf(noSessionsView.tree).indexOf('无法开启辅助对话') >= 0, textOf(noSessionsView.tree));
  ok('errors: the error status exposes a retry button', !!findByType(noSessionsView.tree, 'button'));
  ok('errors: the seat records no uncaught render errors', noSessionsView.errors.length === 0, JSON.stringify(noSessionsView.errors));
  ok('errors: no branch is retained when the service is missing', noSessions.state.retained.length === 0);

  /* retry recovers once the service comes back */
  let retryError = null;
  try {
    const retryButton = findByType(noSessionsView.tree, 'button');
    noSessions.services.sessions = savedSessions;
    retryButton.props.onClick(null);
    await noSessions.flush();
  } catch (error) {
    retryError = error;
  }
  ok('errors: retry does not throw', !retryError, retryError && retryError.message);
  ok('errors: retry recreates the branch once the service returns',
    !!noSessionsView.tree && noSessionsView.tree.props.className === 'dac-root',
    noSessionsView.tree && noSessionsView.tree.props && noSessionsView.tree.props.className);
  noSessionsView.unmount();
  await noSessions.flush();

  /* ---------------- G: create() failure surfaces its detail ---------------- */
  const createFails = h.createHost();
  createFails.state.mainReference = null;
  createFails.state.createImpl = function () {
    return Promise.resolve({ ok: false, error: { code: 'create/failed', message: 'disk full' } });
  };
  createFails.initialize();
  const createFailsView = createFails.mount(tabComponent(createFails), tabProps(null));
  await createFails.flush();
  const createDetail = textOf(createFailsView.tree);
  ok('errors: a failed create shows the error status', !!createFailsView.tree && createFailsView.tree.props.className === 'dac-status');
  ok('errors: a failed create surfaces the host message', createDetail.indexOf('disk full') >= 0, createDetail);
  ok('errors: a failed create does not retain anything', createFails.state.retained.length === 0);
  createFailsView.unmount();
  await createFails.flush();

  /* ---------------- H: idOf contract shapes ---------------- */
  const shapes = [
    { label: 'a bare session id string', value: 'direct-id', expected: 'direct-id' },
    { label: 'a { sessionId } object', value: { sessionId: 'object-id' }, expected: 'object-id' },
    { label: 'an ok/value string envelope', value: { ok: true, value: 'envelope-id' }, expected: 'envelope-id' },
    { label: 'an ok/value session envelope', value: { ok: true, value: { sessionId: 'nested-id' } }, expected: 'nested-id' },
    {
      label: 'a workspace-attach failure with a session id',
      value: { ok: false, error: { code: 'session/workspace-attach-failed', details: { sessionId: 'attach-id' } } },
      expected: 'attach-id',
    },
  ];
  for (let i = 0; i < shapes.length; i += 1) {
    const shape = shapes[i];
    const shapeHost = h.createHost();
    shapeHost.state.mainReference = null;
    shapeHost.state.createImpl = function () { return Promise.resolve(shape.value); };
    shapeHost.initialize();
    const shapeView = shapeHost.mount(tabComponent(shapeHost), tabProps(null));
    await shapeHost.flush();
    ok('errors: create() accepts ' + shape.label, shapeHost.state.retained.length === 1 && shapeHost.state.retained[0].sessionId === shape.expected,
      JSON.stringify(shapeHost.state.retained.map(function (ref) { return ref.sessionId; })));
    shapeView.unmount();
    await shapeHost.flush();
  }

  /* ---------------- I: conversation surface without a factory ---------------- */
  const convEntry = noMain.entry(h.CONV_SLOT);
  const conv = noMain.render(convEntry.Component, conversationProps({ renderFactorySlot: undefined })).tree;
  ok('errors: the conversation surface degrades without a factory renderer', !!conv && conv.props && conv.props.className === 'dac-status',
    conv && JSON.stringify(conv.props));
  ok('errors: the degraded conversation surface explains the failure', textOf(conv).indexOf('无法开启辅助对话') >= 0, textOf(conv));

  /* ---------------- J: no MutationObserver / broken DOM ---------------- */
  const noObserver = h.createHost();
  delete noObserver.sandbox.MutationObserver;
  let noObserverError = null;
  try {
    noObserver.initialize();
  } catch (error) {
    noObserverError = error;
  }
  ok('errors: apply() survives a host without MutationObserver', !noObserverError, noObserverError && noObserverError.message);
  ok('errors: only the main stylesheet is injected without an observer', noObserver.styleElements().length === 1,
    String(noObserver.styleElements().length));

  const brokenDom = h.createHost();
  brokenDom.document.querySelectorAll = function () { throw new Error('querySelectorAll exploded'); };
  let brokenDomError = null;
  try {
    brokenDom.initialize();
    brokenDom.notifyMutations();
  } catch (error) {
    brokenDomError = error;
  }
  ok('errors: a throwing querySelectorAll does not escape the catalog hook', !brokenDomError, brokenDomError && brokenDomError.message);
  ok('errors: a throwing querySelectorAll is reported through the catalog warning channel',
    brokenDom.state.warnings.some(function (line) { return line.toLowerCase().indexOf('catalog') >= 0; }), JSON.stringify(brokenDom.state.warnings));
  ok('errors: the catalog hook still registers its seats with a broken DOM', brokenDom.state.slotRegistrations.length === 4);

  /* ---------------- K: header without a locale service ---------------- */
  const noLocale = h.createHost();
  noLocale.services.locale = undefined;
  noLocale.initialize();
  const noLocaleHeader = noLocale.render(headerComponent(noLocale), {}).tree;
  ok('errors: the header renders without a locale service', !!noLocaleHeader && noLocaleHeader.type === 'button');
  ok('errors: the header falls back to Simplified Chinese without a locale service', textOf(noLocaleHeader).indexOf('辅助对话') >= 0, textOf(noLocaleHeader));
};
