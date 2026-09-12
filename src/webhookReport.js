function formatCurrency(amount) {
  const text = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return amount < 0 ? `-$${text}` : `$${text}`;
}

// Discord and Slack expect different envelopes for a rich message; a plain
// "generic" mode posts a flat JSON body for any other webhook receiver
// (e.g. a custom automation) that just wants the raw numbers.
function buildWebhookPayload(platform, { added, bankSyncIssue, totalBalance, publicUrl }) {
  const title = bankSyncIssue ? '⚠️ Budget Sync Alert: Connection Issues' : `Budget Sync: ${added.length} New Transaction${added.length === 1 ? '' : 's'}`;
  const lines = added.slice(0, 10).map(t => `${t.payee_name || 'Unknown'} — ${formatCurrency(t.amount / 100)}`);
  if (added.length > 10) lines.push(`…and ${added.length - 10} more`);

  const summary = [
    `Total balance: ${formatCurrency(totalBalance)}`,
    bankSyncIssue ? `Connection issue: ${bankSyncIssue}` : null,
    lines.length ? lines.join('\n') : 'No new transactions.'
  ].filter(Boolean).join('\n\n');

  if (platform === 'discord') {
    return {
      embeds: [{
        title,
        description: summary,
        color: bankSyncIssue ? 0xC4573F : 0x0EA894,
        url: publicUrl || undefined
      }]
    };
  }

  if (platform === 'slack') {
    return {
      text: title,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: title } },
        { type: 'section', text: { type: 'mrkdwn', text: summary } },
        ...(publicUrl ? [{ type: 'section', text: { type: 'mrkdwn', text: `<${publicUrl}|View Full Report>` } }] : [])
      ]
    };
  }

  return { title, totalBalance, bankSyncIssue, addedCount: added.length, added, publicUrl };
}

async function sendWebhookReport(config, reportData) {
  const payload = buildWebhookPayload(config.webhookPlatform, reportData);
  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Webhook request failed with status ${response.status}`);
  }
}

module.exports = { buildWebhookPayload, sendWebhookReport };
