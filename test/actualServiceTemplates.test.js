const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// setCategoryTemplate/getBudgetTemplates read a category's note
// (api.getNote) and write it back (api.updateNote) -- both calls into
// @actual-app/api, which needs a live server. Stubbed at the
// module-resolution level, same technique as
// actualServicePagination.test.js, so this is checked against the real
// actualService.js wiring, not just the pure helpers it calls.
//
// Important: api.getNote resolves to a { id, note } row (or null), per
// @actual-app/api's own methods.d.ts (`Promise<NoteEntity | null>`) --
// NOT the note string itself. The fake below mirrors that exact shape:
// earlier versions of this fake (and of actualService.js) treated the
// resolved value as a plain string, which happened to make the read path
// silently fail in production (every note stringified to "[object
// Object]", so no template ever parsed) while still passing this test,
// since the fake's wrong shape matched the code's wrong assumption.
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === '@actual-app/api') return request;
  return origResolveFilename.call(this, request, ...args);
};

function installFakeApi(notesByCategory) {
  let lastUpdate = null;
  const fakeApi = {
    getNote: async (id) => (notesByCategory[id] != null ? { id, note: notesByCategory[id] } : null),
    updateNote: async (id, note) => { lastUpdate = { id, note }; }
  };
  require.cache['@actual-app/api'] = {
    id: '@actual-app/api', filename: '@actual-app/api', loaded: true,
    exports: Object.assign(fakeApi, { q: () => ({}) })
  };
  return () => lastUpdate;
}

function installFullFakeApi({ categories, notesByCategory, budgetMonth, monthlySpendCentsByCategory = {} }) {
  const fakeApi = {
    getCategories: async () => categories,
    getCategoryGroups: async () => [{ id: 'g1', name: 'Group', categories }],
    getNote: async (id) => (notesByCategory[id] != null ? { id, note: notesByCategory[id] } : null),
    getBudgetMonths: async () => [budgetMonth.month],
    getBudgetMonth: async () => ({
      totalIncome: 0, totalSpent: 0,
      categoryGroups: [{ id: 'g1', name: 'Group', is_income: false, hidden: false, categories: budgetMonth.categories }]
    })
  };
  const chain = {
    options: () => chain, filter: () => chain, groupBy: () => chain, select: () => chain, limit: () => chain, offset: () => chain, calculate: () => chain
  };
  // Not date-range aware -- getCategorySpendTrend queries once per trailing
  // month, and every call here gets the same per-category total, which is
  // enough to verify the resulting average without reimplementing real
  // transaction filtering.
  const runQuery = async () => ({
    data: Object.entries(monthlySpendCentsByCategory).map(([category, total]) => ({ category, total: -total }))
  });
  require.cache['@actual-app/api'] = {
    id: '@actual-app/api', filename: '@actual-app/api', loaded: true,
    exports: Object.assign(fakeApi, { q: () => chain, runQuery })
  };
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

describe('getBudgetTemplates', () => {
  test('reads an existing #template note back as a parsed rule, not "No Template"', async () => {
    const categories = [{ id: 'cat1', name: 'Restaurants & Out to Eat', is_income: false, hidden: false }];
    installFullFakeApi({
      categories,
      notesByCategory: { cat1: '#template 600' },
      budgetMonth: { month: '2026-11', categories: [{ id: 'cat1', name: 'Restaurants & Out to Eat', budgeted: 60000, spent: 0, balance: 0 }] }
    });
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const { rows } = await actualService.getBudgetTemplates();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'simple');
    assert.equal(rows[0].fields.monthly, 600);
    assert.equal(rows[0].computable, true);
    assert.equal(rows[0].computedAmount, 600);
    assert.equal(rows[0].avgSpend, 0);
  });

  test('includes the trailing 12-month average spend for comparison against the template and budget', async () => {
    const categories = [{ id: 'cat1', name: 'Groceries', is_income: false, hidden: false }];
    installFullFakeApi({
      categories,
      notesByCategory: { cat1: '#template 1000' },
      budgetMonth: { month: '2026-11', categories: [{ id: 'cat1', name: 'Groceries', budgeted: 100000, spent: 0, balance: 0 }] },
      monthlySpendCentsByCategory: { cat1: 125000 }
    });
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const { rows } = await actualService.getBudgetTemplates();
    assert.equal(rows[0].avgSpend, 1250);
    assert.equal(rows[0].budgeted, 1000);
    assert.equal(rows[0].computedAmount, 1000);
  });

  test('a category with no note comes back with no template, not an error', async () => {
    const categories = [{ id: 'cat1', name: 'Groceries', is_income: false, hidden: false }];
    installFullFakeApi({
      categories,
      notesByCategory: {},
      budgetMonth: { month: '2026-11', categories: [{ id: 'cat1', name: 'Groceries', budgeted: 0, spent: 0, balance: 0 }] }
    });
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const { rows } = await actualService.getBudgetTemplates();
    assert.equal(rows[0].type, null);
  });
});
