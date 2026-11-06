// Locale suite: the packaged locale/<lang>.json bundles and the fallback tables
// embedded in client.js must stay complete and in sync for zh and en.
'use strict';

const h = require('./_harness.cjs');

function placeholders(value) {
  const found = [];
  const re = /\{(\w+)\}/g;
  let match;
  while ((match = re.exec(String(value))) !== null) found.push(match[1]);
  return found.sort();
}

module.exports.run = function run(ok) {
  let zh;
  let en;
  let zhError = null;
  try {
    zh = h.readLocaleFile('zh');
    en = h.readLocaleFile('en');
  } catch (error) {
    zhError = error;
  }
  ok('locale: both zh.json and en.json parse as JSON', !zhError, zhError && zhError.message);
  if (zhError) return;

  const source = h.readClientSource();
  const usedKeys = h.extractLocaleKeys(source);
  ok('locale: client.js resolves UI copy through t()/tr() keys', usedKeys.length >= 8, JSON.stringify(usedKeys));

  const zhKeys = Object.keys(zh).filter(function (key) { return key !== 'meta'; }).sort();
  const enKeys = Object.keys(en).filter(function (key) { return key !== 'meta'; }).sort();
  ok('locale: zh.json and en.json expose the same key set', JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    JSON.stringify({ zhOnly: zhKeys.filter(function (k) { return enKeys.indexOf(k) < 0; }), enOnly: enKeys.filter(function (k) { return zhKeys.indexOf(k) < 0; }) }));
  ok('locale: both bundles declare meta.title and meta.description',
    !!(zh.meta && typeof zh.meta.title === 'string' && zh.meta.title !== '' && typeof zh.meta.description === 'string' && zh.meta.description !== '')
    && !!(en.meta && typeof en.meta.title === 'string' && en.meta.title !== '' && typeof en.meta.description === 'string' && en.meta.description !== ''));

  const emptyValues = zhKeys.filter(function (key) { return typeof zh[key] !== 'string' || zh[key] === ''; })
    .concat(enKeys.filter(function (key) { return typeof en[key] !== 'string' || en[key] === ''; }));
  ok('locale: every key holds a non-empty string in both bundles', emptyValues.length === 0, JSON.stringify(emptyValues));

  const missingZh = usedKeys.filter(function (key) { return Object.prototype.hasOwnProperty.call(zh, key) === false; });
  const missingEn = usedKeys.filter(function (key) { return Object.prototype.hasOwnProperty.call(en, key) === false; });
  ok('locale: zh.json covers every t() key used by client.js', missingZh.length === 0, JSON.stringify(missingZh));
  ok('locale: en.json covers every t() key used by client.js', missingEn.length === 0, JSON.stringify(missingEn));

  const placeholderMismatch = zhKeys.filter(function (key) {
    if (!Object.prototype.hasOwnProperty.call(en, key)) return false;
    return JSON.stringify(placeholders(zh[key])) !== JSON.stringify(placeholders(en[key]));
  });
  ok('locale: zh and en agree on {placeholder} names', placeholderMismatch.length === 0, JSON.stringify(placeholderMismatch));

  const zhTable = h.findEmbeddedTable(source, 'ZH');
  const enTable = h.findEmbeddedTable(source, 'EN');
  ok('locale: client.js embeds a ZH fallback table', !!zhTable && zhTable.keys.length >= 8, zhTable && JSON.stringify(zhTable.keys));
  ok('locale: client.js embeds an EN fallback table', !!enTable && enTable.keys.length >= 8, enTable && JSON.stringify(enTable.keys));
  if (zhTable && enTable) {
    const zhTableKeys = zhTable.keys.slice().sort();
    const enTableKeys = enTable.keys.slice().sort();
    ok('locale: ZH and EN fallback tables expose the same keys', JSON.stringify(zhTableKeys) === JSON.stringify(enTableKeys),
      JSON.stringify({ zhOnly: zhTableKeys.filter(function (k) { return enTableKeys.indexOf(k) < 0; }), enOnly: enTableKeys.filter(function (k) { return zhTableKeys.indexOf(k) < 0; }) }));
    const tableMissingUsed = usedKeys.filter(function (key) { return zhTableKeys.indexOf(key) < 0; });
    ok('locale: fallback tables cover every t() key', tableMissingUsed.length === 0, JSON.stringify(tableMissingUsed));
    const tableMissingFile = zhTableKeys.filter(function (key) { return Object.prototype.hasOwnProperty.call(zh, key) === false; });
    ok('locale: locale/zh.json covers every embedded fallback key', tableMissingFile.length === 0, JSON.stringify(tableMissingFile));
    const tableMissingEnFile = enTableKeys.filter(function (key) { return Object.prototype.hasOwnProperty.call(en, key) === false; });
    ok('locale: locale/en.json covers every embedded fallback key', tableMissingEnFile.length === 0, JSON.stringify(tableMissingEnFile));
  }

  const host = h.createHost();
  let applyError = null;
  try {
    host.initialize();
  } catch (error) {
    applyError = error;
  }
  ok('locale: the module applies against a live locale service', !applyError, applyError && applyError.message);
  if (!applyError) {
    const runtimeByLanguage = {};
    host.state.localeRegistrations.forEach(function (entry) {
      runtimeByLanguage[entry.language] = Object.keys(entry.table || {}).sort();
    });
    const expectedZh = zhTable ? zhTable.keys.slice().sort() : [];
    const expectedEn = enTable ? enTable.keys.slice().sort() : [];
    ok('locale: runtime bundles mirror the embedded fallback tables',
      JSON.stringify(runtimeByLanguage.zh) === JSON.stringify(expectedZh)
      && JSON.stringify(runtimeByLanguage.en) === JSON.stringify(expectedEn),
      JSON.stringify(runtimeByLanguage));
    const runtimeNotInFiles = []
      .concat((runtimeByLanguage.zh || []).filter(function (key) { return !Object.prototype.hasOwnProperty.call(zh, key); }))
      .concat((runtimeByLanguage.en || []).filter(function (key) { return !Object.prototype.hasOwnProperty.call(en, key); }));
    ok('locale: every runtime fallback key exists in the packaged locale files', runtimeNotInFiles.length === 0, JSON.stringify(runtimeNotInFiles));
    ok('locale: every locale lookup uses the plugin namespace',
      host.state.localeTCalls.every(function (call) { return call.namespace === h.NS; }),
      JSON.stringify(host.state.localeTCalls.map(function (call) { return call.namespace; })));
  }
};
