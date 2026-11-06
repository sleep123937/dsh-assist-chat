// Lifecycle suite: fork -> ready -> close -> retire (archive), fallbacks to a
// fresh Session, the archived-session gate, and catalog-row hiding. Drives the
// real tab component through the harness React runtime.
'use strict';

const h = require('./_harness.cjs');

function makeTabProps(parentSessionId, overrides) {
  const props = {
    sessionId: '',
    useTabInfo: function () {
      return {
        tab: {
          navigation: {
            params: parentSessionId ? { parent: parentSessionId } : null,
          },
        },
      };
    },
    renderSlot: function (name, slotProps) { return { type: 'slot', name, props: slotProps }; },
    SessionProvider: function SessionProvider() {},
  };
  return Object.assign(props, overrides || {});
}

function textOf(tree) {
  if (tree === null || tree === undefined) return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (typeof tree === 'object') return textOf(tree.children);
  return '';
}

function tabComponent(host) {
  const entry = host.entry('sidebar.right.pane.tab');
  if (!entry) throw new Error('sidebar.right.pane.tab seat was not registered');
  return entry.Component;
}

module.exports.run = async function run(ok) {
  /* ---------------- A: fork -> ready -> hide -> close -> archive ---------------- */
  const host = h.createHost();
  const mainRow = host.addSessionRow('main-1');
  host.initialize();
  const props = makeTabProps('main-1');
  const view = host.mount(tabComponent(host), props);

  ok('lifecycle: seat shows a status shell while the branch is prepared', view.tree && view.tree.props && view.tree.props.className === 'dac-status',
    view.tree && JSON.stringify(view.tree.props));
  ok('lifecycle: status shell advertises the creating phase', textOf(view.tree).indexOf('正在准备辅助对话') >= 0, textOf(view.tree));

  await host.flush();

  ok('lifecycle: mount forks the main conversation exactly once', host.state.forkRequests.length === 1, JSON.stringify(host.state.forkRequests));
  ok('lifecycle: fork targets the current main session', host.state.forkRequests[0] && host.state.forkRequests[0].sessionId === 'main-1');
  ok('lifecycle: fork asks for an increased title', host.state.forkRequests[0] && host.state.forkRequests[0].increaseTitle === true);
  ok('lifecycle: no fresh Session is created when the fork succeeds', host.state.createRequests.length === 0, JSON.stringify(host.state.createRequests));
  ok('lifecycle: the forked branch is retained for the seat', host.state.retained.length === 1 && host.state.retained[0].sessionId === 'side-1',
    JSON.stringify(host.state.retained.map(function (ref) { return ref.sessionId; })));
  ok('lifecycle: retain marks the sidebar as the source', host.state.retained[0] && host.state.retained[0].options.source === h.PLUGIN_ID + '/sidebar',
    host.state.retained[0] && host.state.retained[0].options.source);
  ok('lifecycle: retain passes the abort signal of the seat effect',
    !!(host.state.retained[0] && host.state.retained[0].options.signal) && typeof host.state.retained[0].options.signal.aborted === 'boolean');
  ok('lifecycle: the branch receives a readable label', host.state.renamed.length === 1 && host.state.renamed[0].sessionId === 'side-1'
    && host.state.renamed[0].title === '辅助对话 1', JSON.stringify(host.state.renamed));

  ok('lifecycle: ready seat renders the embedded root', !!view.tree && view.tree.type === 'div' && view.tree.props.className === 'dac-root',
    view.tree && JSON.stringify(view.tree.props));
  ok('lifecycle: ready seat is tagged with data-assist-chat', !!view.tree && view.tree.props['data-assist-chat'] === '');
  const provider = view.tree && (Array.isArray(view.tree.children) ? view.tree.children[0] : view.tree.children);
  ok('lifecycle: ready seat wraps the branch in a SessionProvider', !!provider && provider.type === props.SessionProvider,
    provider && String(provider.type));
  ok('lifecycle: SessionProvider receives the retained reference', !!provider && provider.props && provider.props.session === host.state.retained[0]);
  const slotTree = provider && provider.children;
  ok('lifecycle: ready seat renders the assist conversation slot', !!slotTree && slotTree.type === 'slot' && slotTree.name === h.CONV_SLOT,
    slotTree && JSON.stringify({ type: slotTree.type, name: slotTree.name }));

  const sideRow = host.addSessionRow('side-1');
  host.notifyMutations();
  ok('lifecycle: the side branch row disappears from the left catalog', host.isRowHidden(sideRow), JSON.stringify(sideRow.getAttribute('data-assist-hidden')));
  ok('lifecycle: the main session row stays visible in the left catalog', !host.isRowHidden(mainRow));

  view.unmount();
  await host.flush();
  ok('lifecycle: closing the seat releases the retained session', host.state.released.indexOf('side-1') >= 0, JSON.stringify(host.state.released));
  ok('lifecycle: closing the seat archives the idle branch', host.state.archived.indexOf('side-1') >= 0, JSON.stringify(host.state.archived));
  ok('lifecycle: closing the seat never archives the main session', host.state.archived.indexOf('main-1') < 0, JSON.stringify(host.state.archived));
  ok('lifecycle: unmount records no effect errors', view.errors.length === 0, JSON.stringify(view.errors));

  /* the retired branch must stop being hidden, so no stale mark survives in the catalog */
  host.notifyMutations();
  ok('lifecycle: retiring a branch releases its catalog hiding mark', !sideRow.hasAttribute('data-assist-hidden'),
    JSON.stringify(sideRow.getAttribute('data-assist-hidden')));

  /* reopening must fork the main conversation again instead of reusing a stale branch */
  const second = host.mount(tabComponent(host), makeTabProps('main-1'));
  await host.flush();
  ok('lifecycle: reopening forks the main conversation again', host.state.forkRequests.length === 2, String(host.state.forkRequests.length));
  ok('lifecycle: reopening relabels the new branch', host.state.renamed.length === 2
    && host.state.renamed[1].title !== host.state.renamed[0].title, JSON.stringify(host.state.renamed.map(function (entry) { return entry.title; })));
  second.unmount();
  await host.flush();

  /* ---------------- B: no main session -> fresh Session ---------------- */
  const noMain = h.createHost();
  noMain.state.mainReference = null;
  noMain.initialize();
  const noMainView = noMain.mount(tabComponent(noMain), makeTabProps(null));
  await noMain.flush();
  ok('lifecycle: a missing main session skips the fork', noMain.state.forkRequests.length === 0, JSON.stringify(noMain.state.forkRequests));
  ok('lifecycle: a missing main session creates a fresh session in the workspace',
    noMain.state.createRequests.length === 1 && noMain.state.createRequests[0].workspaceId === 'ws-1', JSON.stringify(noMain.state.createRequests));
  ok('lifecycle: the fresh session becomes the side branch', noMain.state.retained.length === 1 && noMain.state.retained[0].sessionId === 'side-1');
  noMainView.unmount();
  await noMain.flush();

  /* ---------------- C: no uiWorkspace -> fall back to cwd ---------------- */
  const noWorkspace = h.createHost();
  noWorkspace.services.uiWorkspace = undefined;
  noWorkspace.initialize();
  const noWorkspaceView = noWorkspace.mount(tabComponent(noWorkspace), makeTabProps(''));
  await noWorkspace.flush();
  const createRequest = noWorkspace.state.createRequests[0];
  ok('lifecycle: without a workspace the fresh session inherits the main cwd',
    !!createRequest && createRequest.cwd === 'D:/work' && createRequest.workspaceId === undefined, JSON.stringify(createRequest));
  ok('lifecycle: without a workspace the archived-gate write stays quiet', noWorkspace.state.unarchived.length === 0);
  noWorkspaceView.unmount();
  await noWorkspace.flush();

  /* ---------------- D: blank parent -> no fork ---------------- */
  const blank = h.createHost();
  blank.state.sessionsSnapshot.byId['main-1'].blank = true;
  blank.initialize();
  const blankView = blank.mount(tabComponent(blank), makeTabProps('main-1'));
  await blank.flush();
  ok('lifecycle: a blank main session is not forked', blank.state.forkRequests.length === 0, JSON.stringify(blank.state.forkRequests));
  ok('lifecycle: a blank main session falls back to a fresh one', blank.state.createRequests.length === 1);
  blankView.unmount();
  await blank.flush();

  /* ---------------- E: failing fork -> fresh Session ---------------- */
  const forkFails = h.createHost();
  forkFails.state.nextSideId = 'fallback-1';
  forkFails.state.forkImpl = function () { return Promise.reject(new Error('fork exploded')); };
  forkFails.initialize();
  const forkFailsView = forkFails.mount(tabComponent(forkFails), makeTabProps('main-1'));
  await forkFails.flush();
  ok('lifecycle: a failing fork is reported as a warning', forkFails.state.warnings.some(function (line) { return line.toLowerCase().indexOf('fork') >= 0; }),
    JSON.stringify(forkFails.state.warnings));
  ok('lifecycle: a failing fork falls back to a fresh session', forkFails.state.createRequests.length === 1, String(forkFails.state.createRequests.length));
  ok('lifecycle: the fallback session becomes the side branch', forkFails.state.retained.length === 1 && forkFails.state.retained[0].sessionId === 'fallback-1',
    JSON.stringify(forkFails.state.retained.map(function (ref) { return ref.sessionId; })));
  forkFailsView.unmount();
  await forkFails.flush();

  /* ---------------- F: fork resolves after the seat closed ---------------- */
  const late = h.createHost();
  let resolveFork = null;
  late.state.forkImpl = function () {
    return new Promise(function (resolve) { resolveFork = resolve; });
  };
  late.initialize();
  const lateView = late.mount(tabComponent(late), makeTabProps('main-1'));
  await late.flush();
  ok('lifecycle: a slow fork stays pending while the seat is open', late.state.forkRequests.length === 1 && late.state.retained.length === 0);
  lateView.unmount();
  resolveFork({ ok: true, value: { sessionId: 'late-1' } });
  await late.flush();
  ok('lifecycle: a fork that lands after unmount is retired', late.state.archived.indexOf('late-1') >= 0, JSON.stringify(late.state.archived));
  ok('lifecycle: a fork that lands after unmount is never retained', late.state.retained.length === 0);
  ok('lifecycle: a fork that lands after unmount is never released', late.state.released.length === 0);

  /* ---------------- G: archived branch is unarchived before use ---------------- */
  const archived = h.createHost();
  archived.state.archivedSessionIds = ['side-1'];
  archived.initialize();
  const archivedView = archived.mount(tabComponent(archived), makeTabProps('main-1'));
  await archived.flush();
  ok('lifecycle: an archived branch is restored before it is used', archived.state.unarchived.indexOf('side-1') >= 0, JSON.stringify(archived.state.unarchived));
  ok('lifecycle: restoring an archived branch still yields a ready seat', !!archivedView.tree && archivedView.tree.props.className === 'dac-root',
    archivedView.tree && archivedView.tree.props && archivedView.tree.props.className);
  archivedView.unmount();
  await archived.flush();

  const writable = h.createHost();
  writable.initialize();
  const writableView = writable.mount(tabComponent(writable), makeTabProps('main-1'));
  await writable.flush();
  ok('lifecycle: a non-archived branch is not unarchived', writable.state.unarchived.length === 0, JSON.stringify(writable.state.unarchived));
  writableView.unmount();
  await writable.flush();

  /* ---------------- H: unarchive failure is swallowed ---------------- */
  const unarchiveFails = h.createHost();
  unarchiveFails.state.archivedSessionIds = ['side-1'];
  unarchiveFails.services.uiWorkspace.unarchiveSession = function () { return Promise.reject(new Error('unarchive exploded')); };
  unarchiveFails.initialize();
  const unarchiveFailsView = unarchiveFails.mount(tabComponent(unarchiveFails), makeTabProps('main-1'));
  await unarchiveFails.flush();
  ok('lifecycle: a rejected unarchive does not break the seat',
    !!unarchiveFailsView.tree && unarchiveFailsView.tree.props.className === 'dac-root',
    unarchiveFailsView.tree && unarchiveFailsView.tree.props && unarchiveFailsView.tree.props.className);
  ok('lifecycle: a rejected unarchive is reported as a warning',
    unarchiveFails.state.warnings.some(function (line) { return line.toLowerCase().indexOf('unarchive') >= 0; }), JSON.stringify(unarchiveFails.state.warnings));
  unarchiveFailsView.unmount();
  await unarchiveFails.flush();

  /* ---------------- I: closing without uiWorkspace stays quiet ---------------- */
  const noArchive = h.createHost();
  noArchive.services.uiWorkspace = undefined;
  noArchive.initialize();
  const noArchiveView = noArchive.mount(tabComponent(noArchive), makeTabProps('main-1'));
  await noArchive.flush();
  let closeError = null;
  try {
    noArchiveView.unmount();
    await noArchive.flush();
  } catch (error) {
    closeError = error;
  }
  ok('lifecycle: closing without an archive service does not throw', !closeError, closeError && closeError.message);
  ok('lifecycle: closing without an archive service releases the branch', noArchive.state.released.indexOf('side-1') >= 0);
};
