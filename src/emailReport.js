const nodemailer = require('nodemailer');
const _ = require('lodash');
const { groupBudgetCategoriesByParent } = require('./actualService');

const ACCENT = '#0EA894';
const CORAL = '#C4573F';
const MUTED = '#8A93A0';
const DOT_PALETTE = ['#0EA894', '#4C8DAE', '#8B7FD1', '#E8A33D', '#9C7A54'];

function formatCurrency(amount) {
  const text = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return amount < 0 ? `-$${text}` : `$${text}`;
}

// Flexbox (display:flex/align-items) isn't reliably honored by every mail
// client (notably the Gmail app), which falls back to normal inline flow —
// the dot then sits on the text's baseline instead of centered against it,
// so the dots end up looking misaligned row to row. A table + vertical-align
// is the standard email-safe way to center a dot against a text label.
function renderAccountRow(acc, balance, dotColor) {
  const balanceColor = balance < 0 ? CORAL : '#1E2A32';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #F0EFEB;">
    <tr>
      <td style="padding:11px 0; vertical-align:middle;">
        <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${dotColor}; vertical-align:middle;"></span>
        <span style="display:inline-block; vertical-align:middle; margin-left:9px; font-weight:600; font-size:14px; color:#33404A;">${_.escape(acc.name)}</span>
      </td>
      <td style="padding:11px 0; text-align:right; vertical-align:middle; white-space:nowrap;">
        <span style="font-weight:700; font-size:14px; color:${balanceColor};">${formatCurrency(balance)}</span>
      </td>
    </tr>
  </table>`;
}

// `nested` draws a category slightly smaller/thinner, used for a category
// rendered under its parent group's own total row (renderBudgetGroup below)
// so the group total visually reads as the parent at a glance.
function renderBudgetRow(cat, { nested = false } = {}) {
  const pct = Math.min(cat.pctUsed, 100);
  const barColor = cat.overBudget ? CORAL : ACCENT;
  const status = cat.overBudget
    ? `<span style="color:${CORAL}; font-weight:700;">-${formatCurrency(Math.abs(cat.remaining))} over</span>`
    : `<span style="color:#4B5760; font-weight:700;">${formatCurrency(cat.remaining)} remaining</span>`;
  // A table row, not flexbox — space-between isn't reliably honored by
  // every mail client (notably the Gmail app), which collapses the name
  // and status right next to each other with no gap at all.
  // Below a threshold, the colored fill is too narrow to hold the "N%"
  // label — right-aligned text in a near-zero-width box overflows out
  // past the *left* edge of the whole bar instead of staying inside its
  // sliver. Below that width, the label moves to its own cell just after
  // the bar (in normal document flow, so it can't overflow) instead.
  const pctLabel = `${cat.pctUsed}%`;
  const barHeight = nested ? 11 : 13;
  const labelFitsInBar = pct >= 15;
  const nameSize = nested ? 12 : 13;
  const nameWeight = nested ? 400 : 600;
  const statusSize = nested ? 11 : 12;
  return `<div style="margin-bottom:12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:5px;">
      <tr>
        <td style="font-size:${nameSize}px; font-weight:${nameWeight}; color:#33404A;">${_.escape(cat.name)}</td>
        <td style="font-size:${statusSize}px; text-align:right; white-space:nowrap; padding-left:10px;">${status}</td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="position:relative; height:${barHeight}px; background:#F0EFEB; border-radius:4px;">
          <div style="position:absolute; left:0; top:0; bottom:0; width:${pct}%; background:${barColor}; border-radius:4px;">
            ${labelFitsInBar ? `<div style="font-size:9px; font-weight:700; color:white; line-height:${barHeight}px; text-align:right; padding-right:6px; white-space:nowrap;">${pctLabel}</div>` : ''}
          </div>
        </td>
        ${labelFitsInBar ? '' : `<td style="vertical-align:middle; white-space:nowrap; padding-left:6px;"><span style="font-size:9px; font-weight:700; color:${barColor};">${pctLabel}</span></td>`}
      </tr>
    </table>
  </div>`;
}

// One category group: its own total row (renderBudgetRow at normal size),
// then each of its categories nested underneath — unless it's the only
// category in the group, in which case the group total and that category
// would be identical, so just the one row is drawn.
function renderBudgetGroup(group) {
  if (group.categories.length === 1) {
    return renderBudgetRow(group.categories[0]);
  }
  return `<div style="margin-bottom:16px;">
    ${renderBudgetRow({ ...group, name: group.groupName })}
    <div style="margin-left:4px; padding-left:12px; border-left:2px solid #F0EFEB;">
      ${group.categories.map(cat => renderBudgetRow(cat, { nested: true })).join('')}
    </div>
  </div>`;
}

function monthLabel(monthStr) {
  const [y, m] = monthStr.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'long' });
}

function monthInitial(monthStr) {
  return monthLabel(monthStr).charAt(0);
}

// No $ sign, no thousands separator, no decimals — used only in the
// 12-month strip's per-column micro-labels, where every character counts
// against a ~40px-wide column.
function compactSigned(n) {
  const rounded = Math.round(n);
  return `${rounded >= 0 ? '+' : '-'}${Math.abs(rounded)}`;
}

// A compact net-per-month bar chart: one bar per month, green for a net
// increase (income > spend) and red for a net decrease — not a separate
// income bar and spend bar, since the "which way did this month go, and by
// how much" question is what a quick email scan actually needs. Bar widths
// are scaled against the largest |net| in the window so the chart reads
// correctly regardless of income level; an all-zero window (no data yet)
// skips the bars rather than dividing by zero.
function renderIncomeVsSpendChart(recentIncomeVsSpend) {
  const maxAbsNet = Math.max(...recentIncomeVsSpend.map(m => Math.abs(m.net)), 0);
  const maxBarWidth = 140;
  const rows = recentIncomeVsSpend.map(m => {
    const color = m.net >= 0 ? ACCENT : CORAL;
    const width = maxAbsNet > 0 ? Math.round((Math.abs(m.net) / maxAbsNet) * maxBarWidth) : 0;
    const sign = m.net >= 0 ? '+' : '-';
    return `<tr>
      <td style="width:70px; font-size:12.5px; font-weight:600; color:#33404A; padding:4px 0;">${monthLabel(m.month)}</td>
      <td style="padding:4px 0;"><div style="width:${width}px; height:12px; background:${color}; border-radius:3px;"></div></td>
      <td style="padding:4px 0 4px 8px; text-align:right; font-size:12.5px; font-weight:700; color:${color}; white-space:nowrap;">${sign}${formatCurrency(Math.abs(m.net))}</td>
    </tr>`;
  }).join('');

  const totalNet = recentIncomeVsSpend.reduce((sum, m) => sum + m.net, 0);
  const totalColor = totalNet >= 0 ? ACCENT : CORAL;
  const totalSign = totalNet >= 0 ? '+' : '-';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #F0EFEB; margin-top:8px; padding-top:8px;">
      <tr>
        <td style="font-size:12.5px; font-weight:700; color:#33404A;">Total (${recentIncomeVsSpend.length} mo)</td>
        <td style="text-align:right; font-size:13.5px; font-weight:700; color:${totalColor};">${totalSign}${formatCurrency(Math.abs(totalNet))}</td>
      </tr>
    </table>`;
}

// A much more compact companion to the chart above: one tiny diverging bar
// per month, time running left-to-right instead of stacked top-to-bottom,
// for a longer window (12 months) than the vertical list is legible at.
// Bars are scaled against the largest single-month |net| in the window, same
// idea as renderIncomeVsSpendChart. A cumulative running-total line is
// overlaid on the SAME zero baseline the bars pivot on (not its own
// independent min/max range) — scaled separately against the largest
// |running total|, since that's a much larger number than any single
// month's net, but anchored to the same zero so the line visibly dips below
// the baseline whenever the rolling total itself goes negative, not just
// when a single month does. Drawn with inline SVG (polyline + circle
// markers, a white halo behind the dark line for legibility crossing both
// bar colors) since a smooth diagonal line can't be built from table cells
// the way the bars themselves are; if a mail client strips SVG, the bars
// and month labels still render fine on their own, just without the line.
function renderIncomeVsSpend12MoStrip(months) {
  if (months.length === 0) return '';
  const n = months.length;
  const barHalf = 17; // px — half of the 34px bar box, where the bars pivot
  const lineHalf = 15; // px — slightly inside the box, same zero baseline as the bars

  const maxAbsNet = Math.max(...months.map(m => Math.abs(m.net)), 0);
  let cumulative = 0;
  const cumulativeByMonth = months.map(m => { cumulative += m.net; return cumulative; });
  const maxAbsCumulative = Math.max(...cumulativeByMonth.map(c => Math.abs(c)), 0);

  const bars = months.map((m, i) => {
    const barPx = maxAbsNet > 0 ? Math.round((Math.abs(m.net) / maxAbsNet) * barHalf) : 0;
    const isPositive = m.net >= 0;
    const color = isPositive ? ACCENT : CORAL;
    const barStyle = isPositive
      ? `bottom:${barHalf}px; height:${barPx}px; border-radius:2px 2px 0 0;`
      : `top:${barHalf}px; height:${barPx}px; border-radius:0 0 2px 2px;`;
    return `<td style="width:${(100 / n).toFixed(4)}%; padding:0 1px;">
      <div style="position:relative; height:34px;">
        <div style="position:absolute; left:0; right:0; top:${barHalf}px; height:1px; background:#F0EFEB;"></div>
        <div style="position:absolute; left:2px; right:2px; ${barStyle} background:${color};"></div>
      </div>
      <div style="text-align:center; font-size:8px; color:${MUTED}; margin-top:2px;">${monthInitial(m.month)}</div>
      <div style="text-align:center; font-size:6.5px; font-weight:700; color:${color}; line-height:1.3; margin-top:1px;">${compactSigned(m.net)}</div>
      <div style="text-align:center; font-size:6px; color:${MUTED}; line-height:1.3;">${compactSigned(cumulativeByMonth[i])}</div>
    </td>`;
  }).join('');

  const colWidth = 120 / n;
  const linePoints = cumulativeByMonth.map((c, i) => {
    const x = (i + 0.5) * colWidth;
    const y = maxAbsCumulative > 0 ? barHalf - (c / maxAbsCumulative) * lineHalf : barHalf;
    return { x, y };
  });
  const pointsAttr = linePoints.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const circles = linePoints.map(p => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="1.1" fill="#33404A" />`).join('');

  const totalNet = months.reduce((sum, m) => sum + m.net, 0);
  const totalColor = totalNet >= 0 ? ACCENT : CORAL;
  const totalSign = totalNet >= 0 ? '+' : '-';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px;">
      <tr>
        <td style="font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${MUTED};">Last ${n} Months <span style="text-transform:none; font-weight:400; color:#A7AEB6;">(line = running total)</span></td>
        <td style="text-align:right; font-size:11px; font-weight:700; color:${totalColor};">Total (${n} mo): ${totalSign}${formatCurrency(Math.abs(totalNet))}</td>
      </tr>
    </table>
    <div style="position:relative;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${bars}</tr></table>
      <svg style="position:absolute; top:0; left:0; width:100%; height:34px; display:block;" viewBox="0 0 120 34" preserveAspectRatio="none">
        <polyline points="${pointsAttr}" fill="none" stroke="#FFFFFF" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round" />
        <polyline points="${pointsAttr}" fill="none" stroke="#33404A" stroke-width="0.45" stroke-linejoin="round" stroke-linecap="round" />
        ${circles}
      </svg>
    </div>`;
}

// Table row, not flexbox — space-between isn't reliably honored by every
// mail client, which otherwise collapses the payee name and amount right
// next to each other with no gap. Shared by New Transactions (grouped by
// account, with each row's category shown) and Uncategorized Transactions
// (grouped by account too, but the category line would just say
// "Uncategorized" on every row — redundant with the section's own heading).
function renderTransactionRow(t, { showCategory = true, categoryMap = {} } = {}) {
  const amt = t.amount / 100;
  const amtColor = amt < 0 ? CORAL : '#1C8C74';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #F0EFEB;">
    <tr>
      <td style="padding:9px 0; vertical-align:top;">
        <div style="font-weight:600; font-size:14px; color:#33404A;">${_.escape(t.payee_name || 'Unknown')}</div>
        ${showCategory ? `<div style="font-size:12px; color:${MUTED}; margin-top:2px;">${_.escape(categoryMap[t.category] || 'Uncategorized')}</div>` : ''}
      </td>
      <td style="padding:9px 0; text-align:right; vertical-align:top; white-space:nowrap; padding-left:10px;">
        <span style="font-weight:700; font-size:14px; color:${amtColor};">${formatCurrency(amt)}</span>
      </td>
    </tr>
  </table>`;
}

// A synthetic "Total" row in the same shape summarizeBudgetCategory()
// produces, so renderBudgetRow() can draw it identically to a real category.
function computeBudgetTotalRow(budgetVsActual) {
  const budgeted = budgetVsActual.reduce((sum, cat) => sum + cat.budgeted, 0);
  const spent = budgetVsActual.reduce((sum, cat) => sum + cat.spent, 0);
  // Sums each category's own `remaining` (Actual's true leftover balance,
  // including any rolled-over funds) rather than recomputing budgeted−spent,
  // so a sinking-fund category funded from savings doesn't make the whole
  // Total row read as over budget.
  const remaining = budgetVsActual.reduce((sum, cat) => sum + cat.remaining, 0);
  const overBudget = remaining < 0;
  const available = remaining + spent;
  const pctUsed = available > 0 ? Math.round((spent / available) * 100) : (spent > 0 ? 100 : 0);
  return { name: 'Total', budgeted, spent, remaining, pctUsed, overBudget };
}

function buildReportHtml({
  accounts, accountBalances, accountMap, categoryMap = {}, added, bankSyncIssue, accountSyncErrors = [],
  totalBalance = 0, budgetVsActual = [], uncategorizedTransactions = [], publicUrl = '', sections = {}, liabilityAccountIds = [],
  recentIncomeVsSpend = [], investmentAccountIds = []
}) {
  const includeBalances = sections.balances !== false;
  const includeTransactions = sections.transactions !== false;
  const includeBudget = sections.budgetVsActual !== false;

  // Never reveals sync status (e.g. a connection issue) in the subject
  // itself — an inbox preview or lock-screen notification shouldn't show
  // that before the email is even opened.
  const subject = added.length > 0
    ? `Actual Budget Sync: ${added.length} New Transaction${added.length === 1 ? '' : 's'}`
    : 'Actual Budget Sync: Summary';

  const groupedTransactions = _.groupBy(added, 'account');

  let html = `<div style="font-family: 'Source Sans 3', system-ui, sans-serif; background:#EDECE8; padding:24px 12px;">
  <div style="max-width:520px; margin:0 auto; background:#FFFFFF; border-radius:14px; overflow:hidden;">

    <div style="background:${ACCENT}; padding:20px 26px;">
      <div style="color:#FFFFFF; font-weight:700; font-size:16px; font-family:'Sora',sans-serif;">Actual Budget Smart Sync</div>
      <div style="color:rgba(255,255,255,0.85); font-size:12.5px; margin-top:3px;">Sync report · ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div>
    </div>

    <div style="padding:26px;">`;

  // Section order (requested): total balance first, then new transactions,
  // then budget graphics, then account status/failures at the bottom.
  if (includeBalances) {
    html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED};">Total Balance</div>
      <div style="font-family:'Sora',sans-serif; font-size:32px; font-weight:800; color:#1E2A32; margin-top:4px; margin-bottom:${investmentAccountIds.length > 0 ? '10px' : '22px'};">${formatCurrency(totalBalance)}</div>`;

    // Only rendered when at least one account is tagged Investment — with
    // none tagged, Total Balance looks exactly as it did before this split.
    if (investmentAccountIds.length > 0) {
      const investmentBalance = accounts
        .filter(acc => investmentAccountIds.includes(acc.id))
        .reduce((sum, acc) => sum + accountBalances[acc.id], 0);
      const cashBalance = totalBalance - investmentBalance;
      html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
        <tr>
          <td style="font-size:11px; color:${MUTED};">Cash: <span style="font-weight:700; color:#33404A;">${formatCurrency(cashBalance)}</span></td>
          <td style="font-size:11px; color:${MUTED}; text-align:right;">Investments: <span style="font-weight:700; color:#33404A;">${formatCurrency(investmentBalance)}</span></td>
        </tr>
      </table>`;
    }

    if (recentIncomeVsSpend.length > 0) {
      // The vertical list always shows just the most recent 3 months,
      // regardless of how much history was fetched — the 12-month strip
      // below it (when there's enough history to make one worthwhile) is
      // for the longer trend, not a duplicate of the same few months.
      const showStrip = recentIncomeVsSpend.length > 3;
      html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED}; margin-bottom:8px;">Income vs Spend</div>
        <div style="margin-bottom:${showStrip ? '10px' : '24px'};">${renderIncomeVsSpendChart(recentIncomeVsSpend.slice(-3))}</div>`;
      if (showStrip) {
        html += `<div style="margin-bottom:24px; padding-top:14px; border-top:1px solid #F0EFEB;">${renderIncomeVsSpend12MoStrip(recentIncomeVsSpend)}</div>`;
      }
    }

    html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED}; margin-bottom:4px;">Liability Accounts</div>
      <div style="margin-bottom:24px;">`;
    // Prefer explicit Liability Account tags when set; fall back to "any
    // account with a negative balance" for installs that haven't tagged yet.
    const liabilityAccounts = liabilityAccountIds.length > 0
      ? accounts.filter(acc => liabilityAccountIds.includes(acc.id))
      : accounts.filter(acc => accountBalances[acc.id] < 0);
    if (liabilityAccounts.length > 0) {
      const totalLiability = liabilityAccounts.reduce((sum, acc) => sum + accountBalances[acc.id], 0);
      html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:2px solid #F0EFEB; margin-bottom:4px;">
        <tr>
          <td style="padding:2px 0 9px; font-weight:700; font-size:13.5px; color:#33404A;">Total Liability</td>
          <td style="padding:2px 0 9px; text-align:right; font-weight:700; font-size:14px; color:${CORAL};">${formatCurrency(totalLiability)}</td>
        </tr>
      </table>`;
      liabilityAccounts.forEach((acc, i) => {
        html += renderAccountRow(acc, accountBalances[acc.id], DOT_PALETTE[i % DOT_PALETTE.length]);
      });
    } else {
      html += `<p style="font-size:13px; color:${MUTED}; margin:0;">No accounts with a negative balance.</p>`;
    }
    html += `</div>`;
  }

  if (includeTransactions) {
    html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED};">New Transactions</div>
      <div style="font-family:'Sora',sans-serif; font-size:32px; font-weight:800; color:#1E2A32; margin-top:4px; margin-bottom:${added.length > 0 ? '14px' : '22px'};">${added.length}</div>`;

    if (added.length > 0) {
      html += `<div style="margin-bottom:24px;">`;
      for (const accountId in groupedTransactions) {
        html += `<p style="font-size:12.5px; color:${MUTED}; margin:14px 0 4px;">${_.escape(accountMap[accountId] || 'Unknown')}</p>`;
        groupedTransactions[accountId].forEach(t => {
          html += renderTransactionRow(t, { showCategory: true, categoryMap });
        });
      }
      html += `</div>`;
    }

    // Every uncategorized transaction across the whole budget (matching
    // Actual's own "N uncategorized transactions" count), not scoped to
    // just this sync's new transactions — so it's easy to spot and fix in
    // Actual before it skews Spend by Category or Spend vs Budget below.
    const uncategorized = uncategorizedTransactions;
    const groupedUncategorized = _.groupBy(uncategorized, 'account');
    html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED};">Uncategorized Transactions</div>
      <div style="font-family:'Sora',sans-serif; font-size:32px; font-weight:800; color:#1E2A32; margin-top:4px; margin-bottom:${uncategorized.length > 0 ? '14px' : '22px'};">${uncategorized.length}</div>`;

    if (uncategorized.length > 0) {
      html += `<div style="margin-bottom:24px;">`;
      for (const accountId in groupedUncategorized) {
        html += `<p style="font-size:12.5px; color:${MUTED}; margin:14px 0 4px;">${_.escape(accountMap[accountId] || 'Unknown')}</p>`;
        groupedUncategorized[accountId].forEach(t => {
          html += renderTransactionRow(t, { showCategory: false });
        });
      }
      html += `</div>`;
    }
  }

  if (includeBudget && budgetVsActual.length > 0) {
    html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED}; margin-bottom:12px;">Spend vs Budget</div>
      <div style="margin-bottom:24px;">`;
    groupBudgetCategoriesByParent(budgetVsActual).forEach(group => { html += renderBudgetGroup(group); });
    html += `<div style="border-top:1px solid #F0EFEB; padding-top:12px; margin-top:4px;">${renderBudgetRow(computeBudgetTotalRow(budgetVsActual))}</div>`;
    html += `</div>`;
  }

  if (publicUrl) {
    html += `<a href="${_.escape(publicUrl)}" style="display:block; text-align:center; background:${ACCENT}; color:#FFFFFF; font-weight:700; font-size:14px; padding:13px; border-radius:999px; text-decoration:none;">View Full Report</a>`;
  }

  // Connection issues are always surfaced regardless of section toggles —
  // this is the one alert users shouldn't be able to silence. Listed at the
  // bottom (below the sections users actually check first) and one row per
  // affected account, rather than only ever naming whichever account
  // runBankSync()'s own thrown error happened to be about.
  if (accountSyncErrors.length > 0 || bankSyncIssue) {
    const items = accountSyncErrors.length > 0
      ? accountSyncErrors.map(e => `<strong>${_.escape(e.accountName)}</strong> — ${_.escape(e.label)}`)
      : [_.escape(bankSyncIssue)];
    html += `<div style="background-color:#fceceb; border-left:4px solid ${CORAL}; padding:15px; border-radius:4px; margin-top:22px;">
        <h4 style="margin:0 0 8px 0; color:#c0392b; font-size:14px;">⚠️ Account Status: Action Required</h4>
        ${items.map(text => `<p style="margin:0 0 4px; font-size:13.5px; color:#4B5760;">${text}</p>`).join('')}
      </div>`;
  }

  html += `</div>
    <div style="padding:14px 26px 20px; text-align:center;">
      <div style="font-size:11.5px; color:#A7AEB6;">Actual Budget Smart Sync · sent from your self-hosted instance</div>
    </div>
  </div>
</div>`;

  return { subject, html };
}

// Accepts comma- or semicolon-separated addresses (the field's placeholder
// documents commas) and tolerates stray whitespace, trailing separators,
// and duplicates rather than passing them straight to nodemailer.
function parseRecipients(emailTo) {
  const addresses = (emailTo || '')
    .split(/[,;]/)
    .map(addr => addr.trim())
    .filter(Boolean);
  return [...new Set(addresses)].join(', ');
}

async function sendReport(config, { subject, html }) {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost, port: parseInt(config.smtpPort), secure: parseInt(config.smtpPort) === 465,
    auth: { user: config.emailUser, pass: config.emailPass }
  });
  await transporter.sendMail({ from: config.emailUser, to: parseRecipients(config.emailTo), subject, html });
}

module.exports = { buildReportHtml, sendReport, parseRecipients };
