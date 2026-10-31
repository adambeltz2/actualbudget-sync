// Pure helpers behind the Budget Templates page -- no @actual-app/api calls,
// same split as budgetReview.js/financialHealth.js/consciousSpending.js.
//
// Actual's Goal Templates feature (node_modules/@actual-app/core/src/server/
// budget/goal-template.pegjs) is a small directive language written into a
// category's note. Writing a line here (via api.updateNote, wired in
// actualService.js) only *defines* the rule -- actually computing and
// budgeting it still requires Actual's own "Apply Template" action, which
// isn't exposed by @actual-app/api. So this module can build the exact
// syntax the grammar expects (buildSyntax), read an existing note back into
// a rule (parseTemplateNote), and estimate what a rule would compute to
// from data this app already has (computeTemplateAmount) -- but it can
// never report a template as truly "applied" beyond comparing its estimate
// to the category's current budgeted amount.
//
// buildSyntax is grammar-verified: every directive type below was tested
// against the real pegjs parser's output during this feature's design.

const TYPE_LABELS = {
  simple: 'Simple', periodic: 'Periodic', by: 'By Date', spend: 'Spend',
  percentage: 'Percentage', schedule: 'Schedule', average: 'Average',
  copy: 'Copy', remainder: 'Remainder', goal: 'Goal'
};

function fmtAmount(n) {
  if (n === null || n === undefined) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0 });
}

// --- Human-readable rule line for the list view ---
function describeRule(type, f = {}) {
  switch (type) {
    case 'simple':
      if (f.monthly != null && f.limitAmount) return `${fmtAmount(f.monthly)} / month, capped at ${fmtAmount(f.limitAmount)}`;
      if (f.monthly != null) return `${fmtAmount(f.monthly)} / month`;
      if (f.limitAmount) return `Up to ${fmtAmount(f.limitAmount)} / month`;
      return '—';
    case 'periodic':
      return `${fmtAmount(f.amount)} every ${f.periodN || 1} ${f.periodUnit || 'months'} starting ${f.starting || '—'}`;
    case 'by':
      return `${fmtAmount(f.amount)} by ${f.month || '—'}${f.repeatN ? ` (repeats every ${f.repeatN} ${f.repeatUnit})` : ''}`;
    case 'spend':
      return `${fmtAmount(f.amount)} by ${f.month || '—'}, spend from ${f.spendFrom || '—'}`;
    case 'percentage':
      return `${f.percent || 0}% of ${f.previous ? 'previous ' : ''}${f.of || 'income'}`;
    case 'schedule':
      return `Tied to "${f.scheduleName || '—'}"${f.full ? ' (full amount)' : ''}${f.adjustment ? ` [${f.adjustment > 0 ? 'increase' : 'decrease'} ${Math.abs(f.adjustment)}${f.adjustmentType === 'percent' ? '%' : ''}]` : ''}`;
    case 'average':
      return `Avg of last ${f.numMonths || 3} months${f.adjustment ? ` [${f.adjustment > 0 ? 'increase' : 'decrease'} ${Math.abs(f.adjustment)}${f.adjustmentType === 'percent' ? '%' : ''}]` : ''}`;
    case 'copy':
      return `Same as ${f.lookBack || 1} month${(f.lookBack || 1) > 1 ? 's' : ''} ago`;
    case 'remainder':
      return `Remainder of To Budget${f.weight && f.weight !== 1 ? ` (weight ${f.weight})` : ''}`;
    case 'goal':
      return `Target balance: ${fmtAmount(f.amount)}`;
    default:
      return '—';
  }
}

// --- Compiles a type + its fields into the exact #template/#goal syntax
// Actual's pegjs grammar (goal-template.pegjs) parses. ---
function buildSyntax(type, f = {}, priority) {
  if (type === 'goal') {
    return f.amount ? `#goal ${f.amount}` : null;
  }
  const prefix = '#template' + (priority ? `-${priority}` : '');
  function limitClause(amount, period, start, hold) {
    if (!amount) return '';
    if (period === 'weekly') return ` up to ${amount} per week starting ${start || '2026-01-01'}${hold ? ' hold' : ''}`;
    if (period === 'daily') return ` up to ${amount} per day${hold ? ' hold' : ''}`;
    return ` up to ${amount}${hold ? ' hold' : ''}`;
  }
  switch (type) {
    case 'simple': {
      if (f.monthly == null && !f.limitAmount) return null;
      if (f.monthly == null) return `${prefix}${limitClause(f.limitAmount, f.limitPeriod, f.limitStart, f.limitHold).trim().replace(/^/, ' ')}`.replace('  ', ' ');
      return `${prefix} ${f.monthly}${limitClause(f.limitAmount, f.limitPeriod, f.limitStart, f.limitHold)}`;
    }
    case 'periodic': {
      if (!f.amount || !f.starting) return null;
      const n = f.periodN || 1;
      const unit = f.periodUnit || 'months';
      const periodText = unit === 'months' ? `${n} months` : (n === 1 ? unit.replace(/s$/, '') : `${n} ${unit}`);
      return `${prefix} ${f.amount} repeat every ${periodText} starting ${f.starting}${limitClause(f.limitAmount, f.limitPeriod, f.limitStart, f.limitHold)}`;
    }
    case 'by': {
      if (!f.amount || !f.month) return null;
      const repeat = f.repeatN ? ` repeat every ${f.repeatN === 1 ? f.repeatUnit.replace(/s$/, '') : `${f.repeatN} ${f.repeatUnit}`}` : '';
      return `${prefix} ${f.amount} by ${f.month}${repeat}`;
    }
    case 'spend': {
      if (!f.amount || !f.month || !f.spendFrom) return null;
      const repeat = f.repeatN ? ` repeat every ${f.repeatN === 1 ? f.repeatUnit.replace(/s$/, '') : `${f.repeatN} ${f.repeatUnit}`}` : '';
      return `${prefix} ${f.amount} by ${f.month} spend from ${f.spendFrom}${repeat}`;
    }
    case 'percentage': {
      if (!f.percent || !f.of) return null;
      return `${prefix} ${f.percent}% of ${f.previous ? 'previous ' : ''}${f.of}`;
    }
    case 'schedule': {
      if (!f.scheduleName) return null;
      const mod = f.adjustment ? ` [${f.adjustment > 0 ? 'increase' : 'decrease'} ${Math.abs(f.adjustment)}${f.adjustmentType === 'percent' ? '%' : ''}]` : '';
      return `${prefix} schedule ${f.full ? 'full ' : ''}${f.scheduleName}${mod}`;
    }
    case 'average': {
      if (!f.numMonths) return null;
      const mod = f.adjustment ? ` [${f.adjustment > 0 ? 'increase' : 'decrease'} ${Math.abs(f.adjustment)}${f.adjustmentType === 'percent' ? '%' : ''}]` : '';
      return `${prefix} average ${f.numMonths} months${mod}`;
    }
    case 'copy': {
      if (!f.lookBack) return null;
      return `${prefix} copy from ${f.lookBack} months ago${limitClause(f.limitAmount, f.limitPeriod, f.limitStart, f.limitHold)}`;
    }
    case 'remainder': {
      return `${prefix} remainder${f.weight && f.weight !== 1 ? ' ' + f.weight : ''}${limitClause(f.limitAmount, f.limitPeriod, f.limitStart, f.limitHold)}`;
    }
    default:
      return null;
  }
}

// --- Inverse of buildSyntax: reads one note's text back into a rule. ---
// Only recognizes syntax this app's own builder could have produced (plus
// the equivalent hand-written forms) -- the full pegjs grammar supports a
// few additional forms (multiple stacked templates, every limit variant)
// this doesn't attempt to round-trip. A note whose #template/#goal line
// doesn't match any pattern below comes back as { type: 'unknown', raw },
// so the UI can show the real existing text rather than silently treating
// an unrecognized rule as "no template" and letting an overwrite erase it
// unseen.
const LIMIT_SUFFIX_RE = /\s+up to\s+(\d+(?:\.\d+)?)(?:\s+per\s+(week|day))?(?:\s+starting\s+(\S+))?(\s+hold)?$/;

function stripLimitSuffix(s) {
  const m = s.match(LIMIT_SUFFIX_RE);
  if (!m) return { base: s, limit: {} };
  return {
    base: s.slice(0, m.index),
    limit: {
      limitAmount: Number(m[1]),
      limitPeriod: m[2] === 'week' ? 'weekly' : m[2] === 'day' ? 'daily' : 'monthly',
      limitStart: m[3] || null,
      limitHold: !!m[4]
    }
  };
}

// "2 months" / "months" (n=1, unit already plural) -> { n, unit }
function parseUnitPhrase(text) {
  const m = text.trim().match(/^(\d+)\s+(\w+)$/);
  if (m) return { n: Number(m[1]), unit: m[2] };
  const word = text.trim();
  return { n: 1, unit: word.endsWith('s') ? word : `${word}s` };
}

function parseTemplateLine(line) {
  const goalMatch = line.match(/^#goal\s+(\d+(?:\.\d+)?)$/);
  if (goalMatch) return { type: 'goal', fields: { amount: Number(goalMatch[1]) }, priority: null };

  const head = line.match(/^#template(?:-(\d+))?\s*(.*)$/);
  if (!head) return null;
  const priority = head[1] ? Number(head[1]) : null;
  let rest = head[2];

  // Simple / periodic / copy / remainder can carry a trailing limit clause.
  const { base, limit } = stripLimitSuffix(rest);

  let m;
  if ((m = base.match(/^average\s+(\d+)\s+months(?:\s+\[(increase|decrease)\s+(\d+(?:\.\d+)?)(%)?\])?$/))) {
    return {
      type: 'average', priority,
      fields: {
        numMonths: Number(m[1]),
        adjustment: m[2] ? (m[2] === 'decrease' ? -Number(m[3]) : Number(m[3])) : null,
        adjustmentType: m[4] ? 'percent' : (m[2] ? 'fixed' : null)
      }
    };
  }
  if ((m = base.match(/^copy from\s+(\d+)\s+months ago$/))) {
    return { type: 'copy', priority, fields: { lookBack: Number(m[1]), ...limit } };
  }
  if ((m = base.match(/^remainder(?:\s+(\d+(?:\.\d+)?))?$/))) {
    return { type: 'remainder', priority, fields: { weight: m[1] ? Number(m[1]) : 1, ...limit } };
  }
  if ((m = rest.match(/^(\d+(?:\.\d+)?)\s+by\s+(\d{4}-\d{2})\s+spend from\s+(\d{4}-\d{2})(?:\s+repeat every\s+(.+))?$/))) {
    const repeat = m[4] ? parseUnitPhrase(m[4]) : null;
    return {
      type: 'spend', priority,
      fields: { amount: Number(m[1]), month: m[2], spendFrom: m[3], repeatN: repeat ? repeat.n : null, repeatUnit: repeat ? repeat.unit : null }
    };
  }
  if ((m = rest.match(/^(\d+(?:\.\d+)?)\s+by\s+(\d{4}-\d{2})(?:\s+repeat every\s+(.+))?$/))) {
    const repeat = m[3] ? parseUnitPhrase(m[3]) : null;
    return {
      type: 'by', priority,
      fields: { amount: Number(m[1]), month: m[2], repeatN: repeat ? repeat.n : null, repeatUnit: repeat ? repeat.unit : null }
    };
  }
  if ((m = rest.match(/^(\d+(?:\.\d+)?)%\s+of\s+(previous\s+)?(.+)$/))) {
    return { type: 'percentage', priority, fields: { percent: Number(m[1]), previous: !!m[2], of: m[3] } };
  }
  if ((m = rest.match(/^schedule\s+(full\s+)?([^[]+?)(?:\s+\[(increase|decrease)\s+(\d+(?:\.\d+)?)(%)?\])?$/))) {
    return {
      type: 'schedule', priority,
      fields: {
        full: !!m[1], scheduleName: m[2].trim(),
        adjustment: m[3] ? (m[3] === 'decrease' ? -Number(m[4]) : Number(m[4])) : null,
        adjustmentType: m[5] ? 'percent' : (m[3] ? 'fixed' : null)
      }
    };
  }
  if ((m = base.match(/^(\d+(?:\.\d+)?)\s+repeat every\s+(.+?)\s+starting\s+(\S+)$/))) {
    const period = parseUnitPhrase(m[2]);
    return { type: 'periodic', priority, fields: { amount: Number(m[1]), periodN: period.n, periodUnit: period.unit, starting: m[3], ...limit } };
  }
  if (base.trim() === '') {
    return { type: 'simple', priority, fields: { monthly: null, ...limit } };
  }
  if ((m = base.match(/^(\d+(?:\.\d+)?)$/))) {
    return { type: 'simple', priority, fields: { monthly: Number(m[1]), ...limit } };
  }

  return { type: 'unknown', priority: null, fields: {}, raw: line };
}

// Scans every line of a category's note for the first recognizable
// #template/#goal directive. Returns null when the note has none.
function parseTemplateNote(note) {
  if (!note) return null;
  const lines = String(note).split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('#template') && !line.startsWith('#goal')) continue;
    return parseTemplateLine(line);
  }
  return null;
}

function applyAdjustment(amount, adjustment, adjustmentType) {
  if (!adjustment) return amount;
  return adjustmentType === 'percent' ? amount * (1 + adjustment / 100) : amount + adjustment;
}

// Number of months from `fromMonth` ("YYYY-MM") through `toMonth`
// inclusive -- how many monthly contributions are left to hit a "by"
// target, counting the current month as the first one.
function monthsRemaining(fromMonth, toMonth) {
  const [fy, fm] = fromMonth.split('-').map(Number);
  const [ty, tm] = toMonth.split('-').map(Number);
  if (!fy || !fm || !ty || !tm) return null;
  return (ty - fy) * 12 + (tm - fm) + 1;
}

// Estimates what a rule would compute to, from data this app already has
// (getCategorySpendTrend / getBudgetVsActual / getIncomeVsSpend) --
// everything short of Actual's own Apply Template action. Types this app
// has no local basis for (schedule, periodic, spend, remainder) come back
// with computable: false rather than a guessed number.
//
// context: { monthlyTotals: [{month, total}] oldest-first for this
// category, income: this month's income dollars, currentMonth: 'YYYY-MM',
// categoryLookup: Map<lowercased name, {budgeted, spent}> }
function computeTemplateAmount(type, fields = {}, context = {}) {
  const { monthlyTotals = [], income = 0, currentMonth, categoryLookup = new Map() } = context;
  switch (type) {
    case 'simple':
      return fields.monthly != null ? { computable: true, amount: fields.monthly } : { computable: false };
    case 'average': {
      if (!fields.numMonths) return { computable: false };
      const recent = monthlyTotals.slice(-fields.numMonths);
      if (recent.length === 0) return { computable: false };
      const avg = recent.reduce((s, m) => s + m.total, 0) / recent.length;
      return { computable: true, amount: Math.round(applyAdjustment(avg, fields.adjustment, fields.adjustmentType) * 100) / 100 };
    }
    case 'copy': {
      const lookBack = fields.lookBack || 1;
      const idx = monthlyTotals.length - lookBack;
      if (idx < 0) return { computable: false };
      return { computable: true, amount: monthlyTotals[idx].total };
    }
    case 'percentage': {
      if (!fields.percent) return { computable: false };
      let base;
      if (!fields.of || fields.of.toLowerCase() === 'income') {
        base = income;
      } else {
        const cat = categoryLookup.get(fields.of.toLowerCase());
        if (!cat) return { computable: false };
        base = fields.previous ? cat.spent : (cat.budgeted || cat.spent);
      }
      return { computable: true, amount: Math.round((fields.percent / 100) * base * 100) / 100 };
    }
    case 'by': {
      if (!fields.amount || !fields.month || !currentMonth) return { computable: false };
      const remaining = monthsRemaining(currentMonth, fields.month);
      if (!remaining) return { computable: false };
      const amount = remaining <= 1 ? fields.amount : fields.amount / remaining;
      return { computable: true, amount: Math.round(amount * 100) / 100 };
    }
    default:
      // schedule, periodic, spend, remainder, goal, unknown -- no local
      // basis to estimate these without data this app doesn't fetch
      // (scheduled-transaction amounts, the "remainder" split across every
      // other remainder category, carryover already saved toward a spend
      // target).
      return { computable: false };
  }
}

module.exports = {
  TYPE_LABELS, describeRule, buildSyntax, parseTemplateNote, parseTemplateLine, computeTemplateAmount, monthsRemaining
};
