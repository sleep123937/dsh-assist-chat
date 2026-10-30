// Smoke test: load the assist-chat Client module in a mocked host and prove that
// apply() wires the right seats and that every component renders safely.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = path.join(__dirname, '..', 'client.js');
const code = fs.readFileSync(SRC, 'utf8');

let failures = 0;
function ok(name, cond, detail) {
  if (cond) { console.log('ok   ' + name); return; }
  failures += 1;
  console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
}

let captured = null;
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  Fragment: Symbol('Fragment'),
};

const createdStyles = [];
const sandbox = {
  console,
  AbortController,
  setTimeout, clearTimeout,
  Promise,
  navigator: { language: 'zh-CN' },
  document: {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => {
      const el = { attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, remove() {} };
      createdStyles.push(el);
      return el;
    },
    head: { appendChild: () => {} },
    body: { addEventListener: () => {}, removeEventListener: () => {} },
  },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};
sandbox.window = {
  __ModuleLoader__: { load(def) { captured = def; } },
  localStorage: sandbox.localStorage,
  innerWidth: 1400, innerHeight: 900,
  addEventListener: () => {}, removeEventListener: () => {},
};
vm.createContext(sandbox);

try {
  vm.runInContext(code, sandbox, { filename: 'client.js' });
} catch (e) {
  console.log('FAIL module load :: ' + e.message);
  process.exit(1);
}

ok('module registers through __ModuleLoader__', !!captured);
ok('factory id is the package name', captured && captured.id === 'dsh-assist-chat', captured && captured.id);

const plugin = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});

ok('factory returns a plugin object', !!plugin && typeof plugin.apply === 'function');
ok('plugin injects slots', Array.isArray(plugin.inject) && plugin.inject[0] === 'slots', JSON.stringify(plugin.inject));

/* ---------- host mocks ---------- */
const registered = [];
const tabTypes = [];
const createdSessions = [];
const retained = [];
const released = [];

const sessions = {
  list: { getSnapshot: () => ({ ids: ['s1'], byId: { s1: { sessionId: 's1', cwd: 'D:/work', updatedAt: 5 } } }) },
  create: async (opts) => { createdSessions.push(opts); return { ok: true, value: { sessionId: 'side-1' } }; },
  retain: (id, options) => {
    const ref = { sessionId: id, options, release: () => released.push(id) };
    retained.push(ref);
    return ref;
  },
};

const services = {
  locale: { register() {}, t: (ns, key) => undefined },
  sessions,
  sidebarRightTabs: { register(def) { tabTypes.push(def); return () => {}; } },
  sidebarRight: { openTab: (kind) => { services.sidebarRight.opened = kind; }, close: () => {} },
  layout: { openRightbar() {}, closeRightbar() {} },
};

const effectDisposers = [];
const ctx = {
  get(key) { return services[key]; },
  effect(fn) { const d = fn(); effectDisposers.push(d); return () => { if (typeof d === 'function') d(); }; },
  slots: {
    inject(slot, cb) { cb(); },
    register(options, Component) { registered.push({ options, Component }); return () => {}; },
  },
};

try {
  plugin.apply(ctx);
  ok('apply() completes without throwing', true);
} catch (e) {
  ok('apply() completes without throwing', false, e.message + '\n' + e.stack);
}

const slotIds = registered.map((r) => r.options.name + ':' + (r.options.key || r.options.id || ''));
console.log('     registered slots: ' + JSON.stringify(slotIds));
console.log('     tab types: ' + JSON.stringify(tabTypes.map((d) => d.id + '/' + d.kind + '/' + d.priority)));

ok('registers the sidebar tab body keyed by impl id', slotIds.indexOf('sidebar.right.pane.tab:dsh-assist-chat') >= 0);
ok('registers the sidebar conversation surface', slotIds.indexOf('sidebar.assist.conversation:') >= 0);
ok('registers the session-header entry', slotIds.indexOf('conversation.session.header.actions:assist-chat-open') >= 0);
ok('registers exactly one sidebar tab type', tabTypes.length === 1, String(tabTypes.length));
ok('tab type kind is assistchat', tabTypes[0] && tabTypes[0].kind === 'assistchat', tabTypes[0] && tabTypes[0].kind);
ok('tab type id is the package name', tabTypes[0] && tabTypes[0].id === 'dsh-assist-chat');
ok('tab type title is a function', tabTypes[0] && typeof tabTypes[0].title === 'function');
ok('tab type ships a guide card', !!(tabTypes[0] && Array.isArray(tabTypes[0].guide) && tabTypes[0].guide.length === 1), JSON.stringify(tabTypes[0] && tabTypes[0].guide));
ok('guide card title is a function', !!(tabTypes[0] && tabTypes[0].guide && typeof tabTypes[0].guide[0].title === 'function'));
ok('guide card has an icon component', !!(tabTypes[0] && tabTypes[0].guide && typeof tabTypes[0].guide[0].icon === 'function'));
ok('injects one style element', createdStyles.length === 1, String(createdStyles.length));

/* ---------- components render ---------- */
function renderEntry(name) {
  const entry = registered.find((r) => r.options.name === name);
  if (!entry) return { error: 'not registered' };
  try {
    return { tree: entry.Component({}) };
  } catch (e) {
    return { error: e.message + '\n' + e.stack };
  }
}

const header = renderEntry('conversation.session.header.actions');
ok('header entry renders', !header.error, header.error);
ok('header entry is a button', header.tree && header.tree.type === 'button', header.tree && String(header.tree.type));

const tab = renderEntry('sidebar.right.pane.tab');
ok('tab body renders in the creating phase', !tab.error, tab.error);
ok('tab body shows a status shell before ready', tab.tree && tab.tree.props && tab.tree.props.className === 'dac-status',
  tab.tree && JSON.stringify(tab.tree.props));

const convEntry = registered.find((r) => r.options.name === 'sidebar.assist.conversation');
const conversationProps = {
  sessionId: 'side-1',
  useSession: (sel) => sel({ blank: true, running: false, awaitingFirstTurn: false, openState: 'open', promptAttempted: false }),
  useConversation: (sel) => sel({ activeTargets: new Set() }),
  useSessions: (sel) => sel({ byId: { 'side-1': { blank: true } } }),
  renderFactorySlot: (factory, props, extra) => ({ type: 'factory', factory, props, extra }),
};
let convTree = null;
let convError = null;
try {
  convTree = convEntry.Component(conversationProps);
} catch (e) {
  convError = e.message + '\n' + e.stack;
}
ok('conversation surface renders', !convError, convError);
ok('conversation surface renders the conversation.content factory',
  convTree && convTree.type === 'factory' && convTree.factory === 'conversation.content',
  convTree && JSON.stringify({ type: convTree.type, factory: convTree.factory }));
ok('conversation surface asks for the embedded variant', convTree && convTree.props && convTree.props.variant === 'embedded');
ok('conversation surface pins the chat view', convTree && convTree.extra && convTree.extra.slots && typeof convTree.extra.slots.views === 'function');

/* ---------- disposal ---------- */
let disposeError = null;
try {
  effectDisposers.forEach((d) => { if (typeof d === 'function') d(); });
} catch (e) {
  disposeError = e.message;
}
ok('disposal is clean', !disposeError, disposeError);

console.log('');
if (failures === 0) {
  console.log('ALL PASS');
} else {
  console.log(failures + ' FAILURE(S)');
  process.exitCode = 1;
}