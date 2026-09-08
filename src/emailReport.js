const nodemailer = require('nodemailer');
const _ = require('lodash');

function buildReportHtml({ accounts, accountBalances, accountMap, added, bankSyncIssue }) {
  let subject = 'Budget Sync: ' + added.length + ' New Transactions';
  if (bankSyncIssue) subject = '⚠️ Budget Sync Alert: Connection Issues';

  const groupedTransactions = _.groupBy(added, 'account');

  let html = `<div style="font-family: sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
    <h2 style="border-bottom: 2px solid #eee; padding-bottom: 10px;">Actual Budget Sync Report</h2>`;

  if (bankSyncIssue) {
    html += `<div style="background-color: #fceceb; border-left: 4px solid #e74c3c; padding: 15px; margin-bottom: 25px;">
        <h4 style="margin: 0 0 5px 0; color: #c0392b;">⚠️ Action Required</h4>
        <p style="margin: 0;">${bankSyncIssue}</p></div>`;
  }

  html += `<table style="width: 100%; border-collapse: collapse; margin-bottom: 35px; font-size: 14px;">
    <tr style="background-color: #f8f9fa; text-align: left; border-bottom: 2px solid #e9ecef;">
      <th style="padding: 10px;">Account</th><th style="text-align: right; padding: 10px;">Balance</th>
    </tr>`;

  for (const acc of accounts) {
    const balance = accountBalances[acc.id];
    const balanceText = balance < 0 ? '-$' + Math.abs(balance).toFixed(2) : '$' + balance.toFixed(2);
    html += `<tr style="border-bottom: 1px solid #f1f3f5;">
      <td style="padding: 10px;">${acc.name}</td><td style="text-align: right; padding: 10px;">${balanceText}</td>
    </tr>`;
  }
  html += `</table>`;

  if (added.length > 0) {
    html += `<h3>New Transactions</h3>`;
    for (const accountId in groupedTransactions) {
      html += `<p><strong>${accountMap[accountId] || 'Unknown'}</strong></p><ul>`;
      groupedTransactions[accountId].forEach(t => {
        const amt = t.amount / 100;
        const amtText = amt < 0 ? '-$' + Math.abs(amt).toFixed(2) : '+$' + amt.toFixed(2);
        html += `<li>${t.date} | ${t.payee_name || 'Unknown'} | ${amtText}</li>`;
      });
      html += `</ul>`;
    }
  }

  html += `</div>`;
  return { subject, html };
}

async function sendReport(config, { subject, html }) {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost, port: parseInt(config.smtpPort), secure: parseInt(config.smtpPort) === 465,
    auth: { user: config.emailUser, pass: config.emailPass }
  });
  await transporter.sendMail({ from: config.emailUser, to: config.emailTo, subject, html });
}

module.exports = { buildReportHtml, sendReport };
