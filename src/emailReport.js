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

function renderAccountRow(acc, balance, dotColor) {
  const balanceColor = balance < 0 ? CORAL : '#1E2A32';
  return `<div style="display:flex; align-items:center; justify-content:space-between; padding:11px 0; border-bottom:1px solid #F0EFEB;">
    <div style="display:flex; align-items:center; gap:9px;">
      <span style="width:8px; height:8px; border-radius:50%; background:${dotColor}; flex-shrink:0;"></span>
      <span style="font-weight:600; font-size:14px; color:#33404A;">${_.escape(acc.name)}</span>
    </div>
    <span style="font-weight:700; font-size:14px; color:${balanceColor};">${formatCurrency(balance)}</span>
  </div>`;
}

function renderBudgetRow(cat) {
  const pct = Math.min(cat.pctUsed, 100);
  const barColor = cat.overBudget ? CORAL : ACCENT;
  const status = cat.overBudget
    ? `<span style="color:${CORAL}; font-weight:700;">-${formatCurrency(Math.abs(cat.remaining))} over</span>`
    : `<span style="color:#4B5760; font-weight:700;">${formatCurrency(cat.remaining)} remaining</span>`;
  return `<div style="margin-bottom:12px;">
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:5px;">
      <span style="font-size:13px; font-weight:600; color:#33404A;">${_.escape(cat.name)}</span>
      <span style="font-size:12px;">${status}</span>
    </div>
    <div style="position:relative; height:13px; background:#F0EFEB; border-radius:4px;">
      <div style="position:absolute; left:0; top:0; bottom:0; width:${pct}%; background:${barColor}; border-radius:4px; display:flex; align-items:center; justify-content:flex-end; padding-right:6px;">
        <span style="font-size:9px; font-weight:700; color:white;">${cat.pctUsed}%</span>
      </div>
    </div>
  </div>`;
}

function buildReportHtml({
  accounts, accountBalances, accountMap, categoryMap = {}, added, bankSyncIssue,
  totalBalance = 0, budgetVsActual = [], publicUrl = '', sections = {}
}) {
  const includeBalances = sections.balances !== false;
  const includeTransactions = sections.transactions !== false;
  const includeBudget = sections.budgetVsActual !== false;

  let subject = 'Budget Sync: ' + added.length + ' New Transactions';
  if (bankSyncIssue) subject = '⚠️ Budget Sync Alert: Connection Issues';

  const groupedTransactions = _.groupBy(added, 'account');

  let html = `<div style="font-family: 'Source Sans 3', system-ui, sans-serif; background:#EDECE8; padding:24px 12px;">
  <div style="max-width:520px; margin:0 auto; background:#FFFFFF; border-radius:14px; overflow:hidden;">

    <div style="background:${ACCENT}; padding:20px 26px;">
      <div style="color:#FFFFFF; font-weight:700; font-size:16px; font-family:'Sora',sans-serif;">Actual Budget Smart Sync</div>
      <div style="color:rgba(255,255,255,0.85); font-size:12.5px; margin-top:3px;">Sync report · ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div>
    </div>

    <div style="padding:26px;">`;

  // Section order (requested): new transactions, then account status/failures,
  // then budget graphics, then account balances.
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
          html += `<div style="display:flex; align-items:flex-start; justify-content:space-between; padding:9px 0; border-bottom:1px solid #F0EFEB;">
            <div>
              <div style="font-weight:600; font-size:14px; color:#33404A;">${_.escape(t.payee_name || 'Unknown')}</div>
              <div style="font-size:12px; color:${MUTED}; margin-top:2px;">${_.escape(categoryMap[t.category] || 'Uncategorized')}</div>
            </div>
            <span style="font-weight:700; font-size:14px; color:${amtColor}; white-space:nowrap;">${formatCurrency(amt)}</span>
          </div>`;
        });
      }
      html += `</div>`;
    }
  }

  // Connection issues are always surfaced regardless of section toggles — this is the one alert users shouldn't be able to silence.
  if (bankSyncIssue) {
    html += `<div style="background-color:#fceceb; border-left:4px solid ${CORAL}; padding:15px; border-radius:4px; margin-bottom:22px;">
        <h4 style="margin:0 0 5px 0; color:#c0392b; font-size:14px;">⚠️ Account Status: Action Required</h4>
        <p style="margin:0; font-size:13.5px; color:#4B5760;">${_.escape(bankSyncIssue)}</p></div>`;
  }

  if (includeBudget && budgetVsActual.length > 0) {
    html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED}; margin-bottom:12px;">Spend vs Budget</div>
      <div style="margin-bottom:24px;">`;
    budgetVsActual.slice(0, 6).forEach(cat => { html += renderBudgetRow(cat); });
    html += `</div>`;
  }

  if (includeBalances) {
    html += `<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED};">Total Balance</div>
      <div style="font-family:'Sora',sans-serif; font-size:32px; font-weight:800; color:#1E2A32; margin-top:4px; margin-bottom:22px;">${formatCurrency(totalBalance)}</div>

      <div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED}; margin-bottom:4px;">Accounts</div>
      <div style="margin-bottom:24px;">`;
    accounts.forEach((acc, i) => {
      html += renderAccountRow(acc, accountBalances[acc.id], DOT_PALETTE[i % DOT_PALETTE.length]);
    });
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
