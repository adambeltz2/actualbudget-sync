const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildCategoryDeltas } = require('../src/trends');

describe('buildCategoryDeltas', () => {
  test('computes delta and pctChange for a category present in both periods', () => {
    const current = [{ categoryId: 'g', name: 'Groceries', total: 600 }];
    const prior = [{ categoryId: 'g', name: 'Groceries', total: 500 }];
    const deltas = buildCategoryDeltas(current, prior);
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].current, 600);
    assert.equal(deltas[0].prior, 500);
    assert.equal(deltas[0].delta, 100);
    assert.equal(deltas[0].pctChange, 20);
  });

  test('a brand new category (no prior spend) reports 100% and the full amount as delta', () => {
    const current = [{ categoryId: 'n', name: 'New Category', total: 250 }];
    const prior = [];
    const deltas = buildCategoryDeltas(current, prior);
    assert.equal(deltas[0].delta, 250);
    assert.equal(deltas[0].pctChange, 100);
  });

  test('a category that dropped to zero still appears, with a negative delta', () => {
    const current = [];
    const prior = [{ categoryId: 'g', name: 'Gone Now', total: 300 }];
    const deltas = buildCategoryDeltas(current, prior);
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].delta, -300);
  });

  test('unchanged categories are omitted entirely', () => {
    const current = [{ categoryId: 'g', name: 'Groceries', total: 500 }];
    const prior = [{ categoryId: 'g', name: 'Groceries', total: 500 }];
    const deltas = buildCategoryDeltas(current, prior);
    assert.equal(deltas.length, 0);
  });

  test('sorts by absolute dollar impact, largest first — a big-percent tiny-dollar move loses to a modest-percent big-dollar move', () => {
    const current = [
      { categoryId: 'tiny', name: 'Tiny', total: 4 }, // +300% but trivial in dollars
      { categoryId: 'huge', name: 'Huge', total: 5500 } // +10% but a large dollar swing
    ];
    const prior = [
      { categoryId: 'tiny', name: 'Tiny', total: 1 },
      { categoryId: 'huge', name: 'Huge', total: 5000 }
    ];
    const deltas = buildCategoryDeltas(current, prior);
    assert.equal(deltas[0].name, 'Huge');
    assert.equal(deltas[1].name, 'Tiny');
  });

  test('carries groupName through from whichever period has it', () => {
    const current = [{ categoryId: 'g', name: 'Groceries', groupName: 'Food & Dining', total: 600 }];
    const prior = [{ categoryId: 'g', name: 'Groceries', total: 500 }];
    const deltas = buildCategoryDeltas(current, prior);
    assert.equal(deltas[0].groupName, 'Food & Dining');
  });

  test('falls back to "Other" when neither period has a groupName', () => {
    const current = [{ categoryId: 'g', name: 'Groceries', total: 600 }];
    const prior = [{ categoryId: 'g', name: 'Groceries', total: 500 }];
    const deltas = buildCategoryDeltas(current, prior);
    assert.equal(deltas[0].groupName, 'Other');
  });

  test('caps to maxResults even when many categories changed', () => {
    // Distinct, monotonically decreasing deltas (Category 0 has the largest)
    // so the cap's ordering is unambiguous.
    const current = Array.from({ length: 20 }, (_, i) => ({ categoryId: `c${i}`, name: `Category ${i}`, total: 1000 - i * 10 }));
    const prior = Array.from({ length: 20 }, (_, i) => ({ categoryId: `c${i}`, name: `Category ${i}`, total: 500 - i * 5 }));
    const deltas = buildCategoryDeltas(current, prior);
    assert.equal(deltas.length, 12);
    assert.equal(deltas[0].name, 'Category 0');
  });
});
