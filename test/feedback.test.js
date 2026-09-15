const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { submitFeedback } = require('../src/feedback');

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

describe('submitFeedback', () => {
  test('rejects when GitHub token or repo is not configured', async () => {
    await assert.rejects(
      submitFeedback({ feedbackGithubToken: '', feedbackGithubRepo: '' }, { message: 'Hello' }),
      /not configured/
    );
  });

  test('posts an issue to the configured repo with the message as the title/body', async () => {
    let capturedUrl, capturedOptions;
    global.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({ html_url: 'https://github.com/o/r/issues/5', number: 5 }) };
    };

    const result = await submitFeedback(
      { feedbackGithubToken: 'tok', feedbackGithubRepo: 'owner/repo' },
      { message: 'The dashboard looks great\nMore detail here.', email: 'a@b.com', appVersion: '1.0.4', commit: 'abc1234' }
    );

    assert.equal(capturedUrl, 'https://api.github.com/repos/owner/repo/issues');
    assert.equal(capturedOptions.headers.Authorization, 'Bearer tok');
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.title, 'The dashboard looks great');
    assert.match(body.body, /More detail here\./);
    assert.match(body.body, /v1\.0\.4, abc1234/);
    assert.match(body.body, /Reply-to: a@b\.com/);
    assert.deepEqual(body.labels, ['feedback']);
    assert.deepEqual(result, { url: 'https://github.com/o/r/issues/5', number: 5 });
  });

  test('surfaces the GitHub API error message on failure', async () => {
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) });

    await assert.rejects(
      submitFeedback({ feedbackGithubToken: 'bad', feedbackGithubRepo: 'owner/repo' }, { message: 'Hi' }),
      /Bad credentials/
    );
  });
});
