// Catalog suite: the hidden side branches must not skew the left catalog's
// "show N more sessions" counters. Covers the snapshot-aware main path and the
// pure-DOM fallback path, idempotency across re-renders, and the empty-group flag.
'use strict';

const h = require('./_harness.cjs');

function tabProps(parentSessionId) {
  return {
    sessionId: '',
    useTabInfo: function () {
      return { tab: { navigation: { params: { parent: parentSessionId } } } };
    },
    renderSlot: function (name, slotProps) { return { type: 'slot', name, props: slotProps }; },
    SessionProvider: function SessionProvider() {},
  };
}

function tabComponent(host) {
  return host.entry('sidebar.right.pane.tab').Component;
}

async function openSideBranch(host, sideId) {
  host.state.nextSideId = sideId;
  const view = host.mount(tabComponent(host), tabProps('main-1'));
  await host.flush();
  return view;
}

function overflowButton(host, groupKey, label) {
  return host.addElement({
    tag: 'button',
    attrs: { 'data-row-key': 'overflow:' + groupKey },
    textContent: label,
  });
}

module.exports.run = async function run(ok) {
  /* ================= main path: snapshot-aware correction ================= */
  const host = h.createHost();
  host.initialize();
  const view1 = await openSideBranch(host, 'side-1');
  const view2 = await openSideBranch(host, 'side-2');
  const view3 = await openSideBranch(host, 'side-3');

  ['side-1', 'side-2', 'side-3'].forEach(function (id) {
    host.state.sessionsSnapshot.ids.push(id);
    host.state.sessionsSnapshot.byId[id] = { sessionId: id, blank: false, updatedAt: 1 };
  });
  host.state.workspaceItems = [
    { workspaceId: 'ws-1', title: 'Work', sessionIds: ['main-1', 'side-1', 'side-2'] },
  ];

  /* ws-1 group: two hidden branches, but only one of them is currently rendered */
  const renderedRow = host.addSessionRow('side-1');
  const wsButton = overflowButton(host, 'ws-1', '展开其余 5 个会话');
  /* the ungrouped bucket: side-3 belongs to no workspace */
  const ungroupedButton = overflowButton(host, '', '展开其余 3 个会话');
  /* a group with no hidden branches must keep its count untouched */
  const cleanButton = overflowButton(host, 'ws-2', '展开其余 2 个会话');
  cleanButton.setAttribute('data-assist-overflow-empty', '1');

  host.notifyMutations();

  ok('catalog: the rendered hidden branch row is still marked hidden', host.isRowHidden(renderedRow),
    JSON.stringify(renderedRow.getAttribute('data-assist-hidden')));
  ok('catalog: the main path only subtracts the collapsed tail (ws group)',
    wsButton.textContent === '展开其余 4 个会话', wsButton.textContent);
  ok('catalog: the main path subtracts the ungrouped tail', ungroupedButton.textContent === '展开其余 2 个会话', ungroupedButton.textContent);
  ok('catalog: a group without hidden branches keeps its counter', cleanButton.textContent === '展开其余 2 个会话', cleanButton.textContent);
  ok('catalog: a non-empty counter drops the empty flag', !cleanButton.hasAttribute('data-assist-overflow-empty'));

  /* idempotent across repeated mutation notifications */
  host.notifyMutations();
  ok('catalog: repeated notifications do not subtract twice', wsButton.textContent === '展开其余 4 个会话', wsButton.textContent);

  /* a React re-render restores the base copy; the next pass must re-apply the fix */
  wsButton.textContent = '展开其余 5 个会话';
  host.notifyMutations();
  ok('catalog: the correction is idempotent across re-renders', wsButton.textContent === '展开其余 4 个会话', wsButton.textContent);

  /* an empty mutation batch must still trigger a sync (host may coalesce records) */
  wsButton.textContent = '展开其余 5 个会话';
  host.notifyMutations([]);
  ok('catalog: an empty mutation batch still triggers the correction', wsButton.textContent === '展开其余 4 个会话', wsButton.textContent);

  /* archiving one hidden branch removes it from the group total */
  host.state.archivedSessionIds.push('side-2');
  host.notifyMutations();
  ok('catalog: archived branches are not subtracted from the counter', wsButton.textContent === '展开其余 5 个会话', wsButton.textContent);
  host.state.archivedSessionIds.length = 0;

  /* blank branches are not part of the catalog either */
  host.state.sessionsSnapshot.byId['side-2'].blank = true;
  host.notifyMutations();
  ok('catalog: blank branches are not subtracted from the counter', wsButton.textContent === '展开其余 5 个会话', wsButton.textContent);
  host.state.sessionsSnapshot.byId['side-2'].blank = false;

  /* ================= fallback path: pure DOM counting ================= */
  const fallback = h.createHost();
  fallback.services.uiWorkspace = undefined;
  fallback.initialize();
  const fallbackView1 = await openSideBranch(fallback, 'side-1');
  const fallbackView2 = await openSideBranch(fallback, 'side-2');

  const container = fallback.addElement({ tag: 'div', className: 'session-group' });
  const fallbackButton = overflowButton(fallback, 'g1', '展开其余 5 个会话');
  container.appendChild(fallbackButton);
  const hiddenRow1 = fallback.addSessionRow('side-1');
  container.appendChild(hiddenRow1);
  const hiddenRow2 = fallback.addSessionRow('side-2');
  container.appendChild(hiddenRow2);
  const visibleRow = fallback.addSessionRow('main-1');
  container.appendChild(visibleRow);

  fallback.notifyMutations();
  ok('catalog: the fallback marks both hidden rows', host.isRowHidden(hiddenRow1) && host.isRowHidden(hiddenRow2));
  ok('catalog: the fallback keeps the visible row', !host.isRowHidden(visibleRow));
  ok('catalog: the fallback subtracts the hidden rows of the group', fallbackButton.textContent === '展开其余 3 个会话', fallbackButton.textContent);
  ok('catalog: the fallback hides the count when everything is hidden',
    !fallbackButton.hasAttribute('data-assist-overflow-empty'), fallbackButton.getAttribute('data-assist-overflow-empty'));

  /* all hidden -> counter clamps to zero and the button is flagged empty */
  const emptyContainer = fallback.addElement({ tag: 'div', className: 'session-group' });
  const emptyButton = overflowButton(fallback, 'g2', '展开其余 1 个会话');
  emptyContainer.appendChild(emptyButton);
  const lastRow = fallback.addSessionRow('side-1');
  emptyContainer.appendChild(lastRow);
  fallback.notifyMutations();
  ok('catalog: an exhausted counter reads zero', emptyButton.textContent === '展开其余 0 个会话', emptyButton.textContent);
  ok('catalog: an exhausted counter is flagged with data-assist-overflow-empty',
    emptyButton.getAttribute('data-assist-overflow-empty') === '1', emptyButton.getAttribute('data-assist-overflow-empty'));

  /* english copy uses the same first-integer rule */
  const englishContainer = fallback.addElement({ tag: 'div', className: 'session-group' });
  const englishButton = overflowButton(fallback, 'g3', 'Show 4 more sessions');
  englishContainer.appendChild(englishButton);
  const englishRow = fallback.addSessionRow('side-2');
  englishContainer.appendChild(englishRow);
  fallback.notifyMutations();
  ok('catalog: the english counter is corrected too', englishButton.textContent === 'Show 3 more sessions', englishButton.textContent);

  /* a group without hidden rows is left alone */
  const untouchedContainer = fallback.addElement({ tag: 'div', className: 'session-group' });
  const untouchedButton = overflowButton(fallback, 'g4', '展开其余 2 个会话');
  untouchedContainer.appendChild(untouchedButton);
  fallback.notifyMutations();
  ok('catalog: a group without hidden rows keeps its counter in the fallback path',
    untouchedButton.textContent === '展开其余 2 个会话', untouchedButton.textContent);

  /* hosts without requestAnimationFrame must still apply the correction */
  const noRaf = h.createHost();
  noRaf.services.uiWorkspace = undefined;
  noRaf.initialize();
  const noRafView = await openSideBranch(noRaf, 'side-1');
  delete noRaf.window.requestAnimationFrame;
  delete noRaf.sandbox.requestAnimationFrame;
  const noRafContainer = noRaf.addElement({ tag: 'div', className: 'session-group' });
  const noRafButton = overflowButton(noRaf, 'g6', '展开其余 4 个会话');
  noRafContainer.appendChild(noRafButton);
  const noRafRow = noRaf.addSessionRow('side-1');
  noRafContainer.appendChild(noRafRow);
  let noRafError = null;
  try {
    noRaf.notifyMutations();
  } catch (error) {
    noRafError = error;
  }
  ok('catalog: a host without requestAnimationFrame still applies the correction',
    !noRafError && noRafButton.textContent === '展开其余 3 个会话', noRafError ? noRafError.message : noRafButton.textContent);
  noRafView.unmount();

  /* malformed / detached count nodes are skipped quietly */
  const orphanButton = overflowButton(fallback, 'orphan', '展开其余 9 个会话');
  const malformedButton = fallback.addElement({ tag: 'button', attrs: { 'data-row-key': 'overflow:g5' }, textContent: '展开更多会话' });
  let malformedError = null;
  try {
    fallback.notifyMutations();
  } catch (error) {
    malformedError = error;
  }
  ok('catalog: a detached counter node does not throw', !malformedError, malformedError && malformedError.message);
  ok('catalog: a detached counter node is left untouched', orphanButton.textContent === '展开其余 9 个会话', orphanButton.textContent);
  ok('catalog: a counter without a number is left untouched', malformedButton.textContent === '展开更多会话', malformedButton.textContent);

  [view1, view2, view3, fallbackView1, fallbackView2].forEach(function (view) { view.unmount(); });
  await host.flush();
};
