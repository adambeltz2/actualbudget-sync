const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  TYPE_LABELS, describeRule, buildSyntax, parseTemplateNote, parseTemplateLine, computeTemplateAmount, monthsRemaining
} = require('../src/budgetTemplates');

describe('buildSyntax', () => {
  test('simple: flat monthly amount', () => {
    assert.equal(buildSyntax('simple', { monthly: 200 }), '#template 200');
  });

  test('simple: monthly amount with a cap', () => {
    assert.equal(buildSyntax('simple', { monthly: 200, limitAmount: 250 }), '#template 200 up to 250');
  });

  test('simple: cap only, no monthly amount', () => {
    assert.equal(buildSyntax('simple', { limitAmount: 500 }), '#template up to 500');
  });

  test('simple: returns null with no fields set', () => {
    assert.equal(buildSyntax('simple', {}), null);
  });

  test('periodic', () => {
    assert.equal(
      buildSyntax('periodic', { amount: 50, periodN: 2, periodUnit: 'weeks', starting: '2026-01-01' }),
      '#template 50 repeat every 2 weeks starting 2026-01-01'
    );
  });

  test('by date', () => {
    assert.equal(buildSyntax('by', { amount: 1200, month: '2026-12' }), '#template 1200 by 2026-12');
  });

  test('by date with repeat', () => {
    assert.equal(
      buildSyntax('by', { amount: 1200, month: '2026-12', repeatN: 1, repeatUnit: 'years' }),
      '#template 1200 by 2026-12 repeat every year'
    );
  });

  test('spend', () => {
    assert.equal(
      buildSyntax('spend', { amount: 1200, month: '2026-12', spendFrom: '2026-06' }),
      '#template 1200 by 2026-12 spend from 2026-06'
    );
  });

  test('percentage of income', () => {
    assert.equal(buildSyntax('percentage', { percent: 10, of: 'income' }), '#template 10% of income');
  });

  test('percentage of a previous category', () => {
    assert.equal(
      buildSyntax('percentage', { percent: 10, of: 'Rent', previous: true }),
      '#template 10% of previous Rent'
    );
  });

  test('schedule', () => {
    assert.equal(
      buildSyntax('schedule', { full: true, scheduleName: 'Rent', adjustment: 10, adjustmentType: 'percent' }),
      '#template schedule full Rent [increase 10%]'
    );
  });

  test('average with a decrease adjustment', () => {
    assert.equal(
      buildSyntax('average', { numMonths: 3, adjustment: -10, adjustmentType: 'percent' }),
      '#template average 3 months [decrease 10%]'
    );
  });

  test('copy', () => {
    assert.equal(buildSyntax('copy', { lookBack: 1 }), '#template copy from 1 months ago');
  });

  test('remainder', () => {
    assert.equal(buildSyntax('remainder', { weight: 2 }), '#template remainder 2');
  });

  test('goal', () => {
    assert.equal(buildSyntax('goal', { amount: 5000 }), '#goal 5000');
  });

  test('priority prefix', () => {
    assert.equal(buildSyntax('simple', { monthly: 200 }, 1), '#template-1 200');
  });
});

describe('parseTemplateLine round-trips every buildSyntax output', () => {
  const cases = [
    { type: 'simple', fields: { monthly: 200 } },
    { type: 'simple', fields: { monthly: 200, limitAmount: 250 } },
    { type: 'periodic', fields: { amount: 50, periodN: 2, periodUnit: 'weeks', starting: '2026-01-01' } },
    { type: 'by', fields: { amount: 1200, month: '2026-12' } },
    { type: 'by', fields: { amount: 1200, month: '2026-12', repeatN: 1, repeatUnit: 'years' } },
    { type: 'spend', fields: { amount: 1200, month: '2026-12', spendFrom: '2026-06' } },
    { type: 'percentage', fields: { percent: 10, of: 'income' } },
    { type: 'percentage', fields: { percent: 10, of: 'Rent', previous: true } },
    { type: 'schedule', fields: { full: true, scheduleName: 'Rent', adjustment: 10, adjustmentType: 'percent' } },
    { type: 'average', fields: { numMonths: 3, adjustment: -10, adjustmentType: 'percent' } },
    { type: 'copy', fields: { lookBack: 1 } },
    { type: 'remainder', fields: { weight: 2 } },
    { type: 'goal', fields: { amount: 5000 } }
  ];

  for (const { type, fields } of cases) {
    test(`${type} ${JSON.stringify(fields)}`, () => {
      const line = buildSyntax(type, fields);
      const parsed = parseTemplateLine(line);
      assert.equal(parsed.type, type);
      for (const [key, value] of Object.entries(fields)) {
        assert.equal(parsed.fields[key], value);
      }
    });
  }

  test('priority prefix round-trips', () => {
    const line = buildSyntax('simple', { monthly: 200 }, 1);
    const parsed = parseTemplateLine(line);
    assert.equal(parsed.priority, 1);
  });

  test('unrecognized directive syntax comes back as unknown with the raw line', () => {
    const parsed = parseTemplateLine('#template weird syntax nobody writes');
    assert.equal(parsed.type, 'unknown');
    assert.equal(parsed.raw, '#template weird syntax nobody writes');
  });
});

describe('parseTemplateNote', () => {
  test('returns null for a note with no directive', () => {
    assert.equal(parseTemplateNote('just a regular note'), null);
  });

  test('returns null for an empty note', () => {
    assert.equal(parseTemplateNote(''), null);
    assert.equal(parseTemplateNote(null), null);
  });

  test('finds the directive line among other note text', () => {
    const parsed = parseTemplateNote('Some comment about this category\n#template 200\nanother line');
    assert.equal(parsed.type, 'simple');
    assert.equal(parsed.fields.monthly, 200);
  });
});

describe('computeTemplateAmount', () => {
  test('simple: the fixed amount, always computable', () => {
    const result = computeTemplateAmount('simple', { monthly: 200 }, {});
    assert.equal(result.computable, true);
    assert.equal(result.amount, 200);
  });

  test('average: mean of the trailing N months', () => {
    const monthlyTotals = [{ month: '2026-07', total: 100 }, { month: '2026-08', total: 200 }, { month: '2026-09', total: 300 }];
    const result = computeTemplateAmount('average', { numMonths: 3 }, { monthlyTotals });
    assert.equal(result.computable, true);
    assert.equal(result.amount, 200);
  });

  test('average: applies a percent adjustment', () => {
    const monthlyTotals = [{ month: '2026-09', total: 100 }];
    const result = computeTemplateAmount('average', { numMonths: 1, adjustment: 10, adjustmentType: 'percent' }, { monthlyTotals });
    assert.equal(result.amount, 110);
  });

  test('average: not computable without enough history', () => {
    const result = computeTemplateAmount('average', { numMonths: 3 }, { monthlyTotals: [] });
    assert.equal(result.computable, false);
  });

  test('copy: the Nth-previous month\'s total', () => {
    const monthlyTotals = [{ month: '2026-08', total: 85 }, { month: '2026-09', total: 95 }];
    const result = computeTemplateAmount('copy', { lookBack: 1 }, { monthlyTotals });
    assert.equal(result.amount, 95);
  });

  test('percentage: of income', () => {
    const result = computeTemplateAmount('percentage', { percent: 10, of: 'income' }, { income: 4000 });
    assert.equal(result.amount, 400);
  });

  test('percentage: of another category\'s current budget', () => {
    const categoryLookup = new Map([['rent', { budgeted: 1500, spent: 1500 }]]);
    const result = computeTemplateAmount('percentage', { percent: 10, of: 'Rent' }, { categoryLookup });
    assert.equal(result.amount, 150);
  });

  test('percentage: not computable when the referenced category is unknown', () => {
    const result = computeTemplateAmount('percentage', { percent: 10, of: 'Nonexistent' }, { categoryLookup: new Map() });
    assert.equal(result.computable, false);
  });

  test('by date: amortizes the remaining amount across the months left', () => {
    const result = computeTemplateAmount('by', { amount: 1200, month: '2027-06' }, { currentMonth: '2026-12' });
    assert.equal(result.computable, true);
    assert.equal(result.amount, 171.43); // 1200 / 7 months remaining (Dec 2026 through June 2027, inclusive)
  });

  test('by date: the full amount when the target month is now or past', () => {
    const result = computeTemplateAmount('by', { amount: 1200, month: '2026-12' }, { currentMonth: '2026-12' });
    assert.equal(result.amount, 1200);
  });

  test('schedule/periodic/spend/remainder: not locally computable', () => {
    assert.equal(computeTemplateAmount('schedule', { scheduleName: 'Rent' }, {}).computable, false);
    assert.equal(computeTemplateAmount('periodic', { amount: 50 }, {}).computable, false);
    assert.equal(computeTemplateAmount('spend', { amount: 100 }, {}).computable, false);
    assert.equal(computeTemplateAmount('remainder', {}, {}).computable, false);
  });
});

describe('monthsRemaining', () => {
  test('counts the current month as the first one', () => {
    assert.equal(monthsRemaining('2026-12', '2026-12'), 1);
  });

  test('spans a year boundary', () => {
    assert.equal(monthsRemaining('2026-12', '2027-06'), 7);
  });
});

describe('describeRule', () => {
  test('describes a simple rule with a cap', () => {
    assert.equal(describeRule('simple', { monthly: 200, limitAmount: 250 }), '$200 / month, capped at $250');
  });

  test('every type has a label', () => {
    for (const type of Object.keys(TYPE_LABELS)) {
      assert.ok(TYPE_LABELS[type]);
    }
  });
});
