// GitHub requires a User-Agent header on API requests or it rejects them outright.
const USER_AGENT = 'actualbudget-sync-feedback';

function buildIssueBody({ message, email, appVersion, commit }) {
  const lines = [
    message.trim(),
    '',
    '---',
    `Submitted from the app's Feedback form (v${appVersion}${commit ? `, ${commit}` : ''}).`
  ];
  if (email) lines.push(`Reply-to: ${email}`);
  return lines.join('\n');
}

async function submitFeedback(config, { message, email, appVersion, commit }) {
  const { feedbackGithubToken, feedbackGithubRepo } = config;
  if (!feedbackGithubToken || !feedbackGithubRepo) {
    throw new Error('Feedback is not configured yet — add a GitHub token and repository in Settings.');
  }

  const title = message.trim().split('\n')[0].slice(0, 80) || 'User feedback';
  const response = await fetch(`https://api.github.com/repos/${feedbackGithubRepo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${feedbackGithubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify({
      title,
      body: buildIssueBody({ message, email, appVersion, commit }),
      labels: ['feedback']
    })
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.message || `GitHub API request failed with status ${response.status}`);
  }

  const issue = await response.json();
  return { url: issue.html_url, number: issue.number };
}

module.exports = { submitFeedback };
