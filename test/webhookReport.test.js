const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildWebhookPayload } = require('../src/webhookReport');

const baseData = {
  added: [
    { payee_name: 'Coffee Shop', amount: -450 },
    { payee_name: 'Paycheck', amount: 150000 }
  ],
  bankSyncIssue: null,
  totalBalance: 1234.56, // account balances arrive already in dollars, unlike transaction amounts (cents)
  publicUrl: 'https://dashboard.example.com'
};

describe('buildWebhookPayload', () => {
  test('discord payload uses an embed with a title and description', () => {
    const payload = buildWebhookPayload('discord', baseData);
    assert.ok(Array.isArray(payload.embeds));
    assert.match(payload.embeds[0].title, /2 New Transactions/);
    assert.match(payload.embeds[0].description, /\$1,234\.56/);
    assert.match(payload.embeds[0].description, /Coffee Shop/);
  });

  test('discord payload uses coral color when there is a bank sync issue', () => {
    const payload = buildWebhookPayload('discord', { ...baseData, bankSyncIssue: 'Connection expired' });
    assert.match(payload.embeds[0].title, /Connection Issues/);
    assert.equal(payload.embeds[0].color, 0xC4573F);
  });

  test('slack payload includes a header block and mrkdwn summary', () => {
    const payload = buildWebhookPayload('slack', baseData);
    assert.equal(payload.blocks[0].type, 'header');
    assert.match(payload.blocks[1].text.text, /Paycheck/);
  });

  test('slack payload adds a link block only when publicUrl is set', () => {
    const withUrl = buildWebhookPayload('slack', baseData);
    const withoutUrl = buildWebhookPayload('slack', { ...baseData, publicUrl: '' });
    assert.equal(withUrl.blocks.length, 3);
    assert.equal(withoutUrl.blocks.length, 2);
  });

  test('generic payload is a flat object with the raw fields', () => {
    const payload = buildWebhookPayload('generic', baseData);
    assert.equal(payload.addedCount, 2);
    assert.equal(payload.totalBalance, 1234.56);
    assert.deepEqual(payload.added, baseData.added);
  });

  test('a single transaction uses singular wording', () => {
    const payload = buildWebhookPayload('discord', { ...baseData, added: [baseData.added[0]] });
    assert.match(payload.embeds[0].title, /1 New Transaction$/);
  });

  test('more than 10 transactions are truncated with a summary line', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ payee_name: `Payee ${i}`, amount: -100 }));
    const payload = buildWebhookPayload('discord', { ...baseData, added: many });
    assert.match(payload.embeds[0].description, /and 2 more/);
  });
});
