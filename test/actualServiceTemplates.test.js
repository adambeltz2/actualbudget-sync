const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// setCategoryTemplate reads a category's note (api.getNote) and writes it
// back (api.updateNote) -- both calls into @actual-app/api, which needs a
// live server. Stubbed at the module-resolution level, same technique as
// actualServicePagination.test.js, so the real splice-not-overwrite
// behavior (preserving any other text already in the note) is verified
// against the real actualService.js wiring, not just the pure
// replaceTemplateInNote helper it calls.
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === '@actual-app/api') return request;
  return origResolveFilename.call(this, request, ...args);
};

function installFakeApi(notesByCategory) {
  let lastUpdate = null;
  const fakeApi = {
    getNote: async (id) => notesByCategory[id] ?? null,
    updateNote: async (id, note) => { lastUpdate = { id, note }; }
  };
  require.cache['@actual-app/api'] = {
    id: '@actual-app/api', filename: '@actual-app/api', loaded: true,
    exports: Object.assign(fakeApi, { q: () => ({}) })
  };
  return () => lastUpdate;
}

describe('setCategoryTemplate', () => {
  test('preserves other text already in the note while swapping the directive line', async () => {
    const getLastUpdate = installFakeApi({ cat1: 'Renews every March\n#template 200' });
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    await actualService.setCategoryTemplate('cat1', '#template 250');
    assert.deepEqual(getLastUpdate(), { id: 'cat1', note: 'Renews every March\n#template 250' });
  });

  test('removing the template (null) keeps the rest of the note intact', async () => {
    const getLastUpdate = installFakeApi({ cat1: 'Renews every March\n#template 200' });
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    await actualService.setCategoryTemplate('cat1', null);
    assert.deepEqual(getLastUpdate(), { id: 'cat1', note: 'Renews every March' });
  });

  test('writing a template to a category with no existing note just adds the line', async () => {
    const getLastUpdate = installFakeApi({ cat1: null });
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    await actualService.setCategoryTemplate('cat1', '#template 100');
    assert.deepEqual(getLastUpdate(), { id: 'cat1', note: '#template 100' });
  });
});
