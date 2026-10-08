const _ = require('lodash');
const { groupBudgetCategoriesByParent } = require('./actualService');
const {
  renderBudgetGroup, computeBudgetTotalRow, renderBudgetRow, formatCurrency, ACCENT, AMBER, MUTED
} = require('./emailReport');
const { computeMonthProgress, computeCategoriesToWatch } = require('./budgetSummary');

// A no-sync, no-transaction-detail companion to the daily sync report:
// where the month's budget stands so far, not what changed since last
// sync. Deliberately reuses buildReportHtml's exact visual components
// (header bar, card shell, budget bars) via emailReport.js's exports —
// same template, different content, so it reads as the same product.
function buildSummaryReportHtml({
  totalBalance = 0, budgetVsActual = [], netSavingsThisMonth = 0, typicalPaceNetSavings = 0,
  publicUrl = '', now = new Date()
}) {
  const { dayOfMonth, daysInMonth, pctMonthElapsed, monthLabel } = computeMonthProgress(now);
  const totalBudgeted = budgetVsActual.reduce((sum, cat) => sum + cat.budgeted, 0);
  const totalSpent = budgetVsActual.reduce((sum, cat) => sum + cat.spent, 0);
  const totalPctUsed = totalBudgeted > 0 ? Math.round((totalSpent / totalBudgeted) * 100) : 0;
  const watchList = computeCategoriesToWatch(budgetVsActual, pctMonthElapsed);

  const subject = `Actual Budget Monthly Summary: ${monthLabel}`;

  let html = `<div style="font-family: 'Source Sans 3', system-ui, sans-serif; background:#EDECE8; padding:24px 12px;">
  <div style="max-width:520px; margin:0 auto; background:#FFFFFF; border-radius:14px; overflow:hidden;">

    <div style="background:${ACCENT}; padding:20px 26px;">
      <div style="color:#FFFFFF; font-weight:700; font-size:16px; font-family:'Sora',sans-serif;">Actual Budget Smart Sync</div>
      <div style="color:rgba(255,255,255,0.85); font-size:12.5px; margin-top:3px;">Monthly Summary · ${_.escape(monthLabel)}</div>
    </div>

    <div style="padding:26px;">
      <div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED};">Total Balance</div>
      <div style="font-family:'Sora',sans-serif; font-size:32px; font-weight:800; color:#1E2A32; margin-top:4px; margin-bottom:22px;">${formatCurrency(totalBalance)}</div>`;

  if (totalBudgeted > 0) {
    html += `<div style="background:#F6F9F8; border:1px solid ${ACCENT}33; border-radius:10px; padding:14px 16px; margin-bottom:24px;">
        <div style="font-size:13px; color:#33404A; line-height:1.5;">
          <strong>Day ${dayOfMonth} of ${daysInMonth}</strong> (${pctMonthElapsed}% through ${_.escape(monthLabel)}) — you've spent <strong>${formatCurrency(totalSpent)}</strong> of your <strong>${formatCurrency(totalBudgeted)}</strong> total budget (${totalPctUsed}%).
        </div>
      </div>`;
  }

  html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${AMBER}; margin-bottom:10px;">⚠ Categories to Watch</div>
      <div style="margin-bottom:24px;">`;
  if (watchList.length > 0) {
    html += watchList.map(c => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF1E2; border-radius:8px; margin-bottom:8px;">
        <tr>
          <td style="padding:10px 12px;">
            <div style="font-size:13px; font-weight:700; color:#33404A;">${_.escape(c.name)}</div>
            <div style="font-size:11.5px; color:${MUTED}; margin-top:2px;">${formatCurrency(c.spent)} of ${formatCurrency(c.budgeted)} spent — at this pace, projected to hit ${formatCurrency(c.projectedTotal)} by month end</div>
          </td>
        </tr>
      </table>`).join('');
  } else {
    html += `<p style="font-size:13px; color:${MUTED}; margin:0;">Nothing running ahead of pace right now — nice.</p>`;
  }
  html += `</div>`;

  html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED}; margin-bottom:4px;">Net Savings This Month</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td style="font-family:'Sora',sans-serif; font-size:28px; font-weight:800; color:${ACCENT};">${formatCurrency(netSavingsThisMonth)}</td>
          <td style="text-align:right; font-size:12px; color:${MUTED}; vertical-align:bottom; padding-bottom:4px;">typical pace at day ${dayOfMonth}: ${formatCurrency(typicalPaceNetSavings)}</td>
        </tr>
      </table>`;

  if (budgetVsActual.length > 0) {
    html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED}; margin-bottom:4px;">Budget Progress by Category</div>
      <div style="font-size:11px; color:${MUTED}; margin-bottom:14px;"><span style="display:inline-block; width:10px; height:2px; background:#1E2A32; opacity:0.45; vertical-align:middle; margin-right:5px;"></span>marks ${pctMonthElapsed}% through the month. A category's pace tag compares its own spend to that line — not a verdict, since a bill paid in full early in the month will always read as "ahead of pace" here even when that's expected.</div>
      <div style="margin-bottom:24px;">`;
    groupBudgetCategoriesByParent(budgetVsActual).forEach(group => { html += renderBudgetGroup(group, pctMonthElapsed); });
    html += `<div style="border-top:1px solid #F0EFEB; padding-top:12px; margin-top:4px;">${renderBudgetRow(computeBudgetTotalRow(budgetVsActual))}</div>`;
    html += `</div>`;
  }

  if (publicUrl) {
    html += `<a href="${_.escape(publicUrl)}" style="display:block; text-align:center; background:${ACCENT}; color:#FFFFFF; font-weight:700; font-size:14px; padding:13px; border-radius:999px; text-decoration:none;">View Full Report</a>`;
  }

  html += `</div>
    <div style="padding:14px 26px 20px; text-align:center;">
      <div style="font-size:11.5px; color:#A7AEB6;">Actual Budget Smart Sync · sent from your self-hosted instance</div>
    </div>
  </div>
</div>`;

  return { subject, html };
}

module.exports = { buildSummaryReportHtml };
