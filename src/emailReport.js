const nodemailer = require('nodemailer');
const _ = require('lodash');

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

function renderBudgetRow(cat) {
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
  const labelFitsInBar = pct >= 15;
  return `<div style="margin-bottom:12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:5px;">
      <tr>
        <td style="font-size:13px; font-weight:600; color:#33404A;">${_.escape(cat.name)}</td>
        <td style="font-size:12px; text-align:right; white-space:nowrap; padding-left:10px;">${status}</td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="position:relative; height:13px; background:#F0EFEB; border-radius:4px;">
          <div style="position:absolute; left:0; top:0; bottom:0; width:${pct}%; background:${barColor}; border-radius:4px;">
            ${labelFitsInBar ? `<div style="font-size:9px; font-weight:700; color:white; line-height:13px; text-align:right; padding-right:6px; white-space:nowrap;">${pctLabel}</div>` : ''}
          </div>
        </td>
        ${labelFitsInBar ? '' : `<td style="vertical-align:middle; white-space:nowrap; padding-left:6px;"><span style="font-size:9px; font-weight:700; color:${barColor};">${pctLabel}</span></td>`}
      </tr>
    </table>
  </div>`;
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
  totalBalance = 0, budgetVsActual = [], publicUrl = '', sections = {}, liabilityAccountIds = []
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
      <div style="font-family:'Sora',sans-serif; font-size:32px; font-weight:800; color:#1E2A32; margin-top:4px; margin-bottom:22px;">${formatCurrency(totalBalance)}</div>

      <div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED}; margin-bottom:4px;">Liability Accounts</div>
      <div style="margin-bottom:24px;">`;
    // Prefer explicit Liability Account tags when set; fall back to "any
    // account with a negative balance" for installs that haven't tagged yet.
    const liabilityAccounts = liabilityAccountIds.length > 0
      ? accounts.filter(acc => liabilityAccountIds.includes(acc.id))
      : accounts.filter(acc => accountBalances[acc.id] < 0);
    if (liabilityAccounts.length > 0) {
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
          const amt = t.amount / 100;
          const amtColor = amt < 0 ? CORAL : '#1C8C74';
          // Table row, not flexbox — space-between isn't reliably honored
          // by every mail client, which otherwise collapses the payee name
          // and amount right next to each other with no gap.
          html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #F0EFEB;">
            <tr>
              <td style="padding:9px 0; vertical-align:top;">
                <div style="font-weight:600; font-size:14px; color:#33404A;">${_.escape(t.payee_name || 'Unknown')}</div>
                <div style="font-size:12px; color:${MUTED}; margin-top:2px;">${_.escape(categoryMap[t.category] || 'Uncategorized')}</div>
              </td>
              <td style="padding:9px 0; text-align:right; vertical-align:top; white-space:nowrap; padding-left:10px;">
                <span style="font-weight:700; font-size:14px; color:${amtColor};">${formatCurrency(amt)}</span>
              </td>
            </tr>
          </table>`;
        });
      }
      html += `</div>`;
    }
  }

  if (includeBudget && budgetVsActual.length > 0) {
    html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED}; margin-bottom:12px;">Spend vs Budget</div>
      <div style="margin-bottom:24px;">`;
    budgetVsActual.forEach(cat => { html += renderBudgetRow(cat); });
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
