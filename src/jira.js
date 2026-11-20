// Read-only Jira Cloud client. It only ever issues GET requests for a ticket's
// title (Jira's "summary" field) and description; it never changes anything in Jira.

/** Flatten Atlassian Document Format (the JSON Jira Cloud v3 uses for descriptions) to plain text. */
export function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  const kids = (n) => (n.content ?? []).map(adfToText).join('');
  switch (node.type) {
    case 'doc':
      return (node.content ?? []).map(adfToText).join('').replace(/\n{3,}/g, '\n\n').trim();
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'paragraph':
    case 'heading':
      return `${kids(node)}\n\n`;
    case 'bulletList':
      return `${(node.content ?? []).map((li) => `- ${adfToText(li).trim()}`).join('\n')}\n\n`;
    case 'orderedList':
      return `${(node.content ?? []).map((li, i) => `${i + 1}. ${adfToText(li).trim()}`).join('\n')}\n\n`;
    case 'listItem':
      return kids(node).trim();
    case 'codeBlock':
      return `${kids(node)}\n\n`;
    case 'blockquote':
    case 'panel':
      return kids(node);
    case 'rule':
      return '---\n\n';
    case 'mention':
      return node.attrs?.text ?? '@someone';
    case 'emoji':
      return node.attrs?.text ?? node.attrs?.shortName ?? '';
    case 'inlineCard':
    case 'blockCard':
      return node.attrs?.url ?? '';
    case 'table':
      return `${(node.content ?? []).map((row) => (row.content ?? []).map((c) => adfToText(c).trim()).join(' | ')).join('\n')}\n\n`;
    default:
      return kids(node);
  }
}

/**
 * Returns null when Jira isn't configured. Configure with JIRA_BASE_URL
 * (https://yourcompany.atlassian.net), JIRA_EMAIL and JIRA_API_TOKEN.
 * The account only needs permission to browse the projects being tracked.
 */
export function createJiraClient({ baseUrl, email, token, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!baseUrl || !email || !token) return null;
  const root = baseUrl.replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

  async function getIssue(key) {
    const url = `${root}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { error: `${key} was not found in Jira (or the tracker's Jira account can't see it)` };
    if (res.status === 401 || res.status === 403) return { error: `Jira refused the tracker's credentials (HTTP ${res.status})` };
    if (!res.ok) return { error: `Jira returned HTTP ${res.status}` };
    const data = await res.json();
    return {
      title: data.fields?.summary ?? key,
      description: typeof data.fields?.description === 'string' ? data.fields.description : adfToText(data.fields?.description),
    };
  }

  return { baseUrl: root, getIssue };
}

/** Fill in a ticket's title/description from Jira when missing or stale. Never throws. */
export async function refreshFromJira(tracker, jira, key, { force = false } = {}) {
  if (!jira) return null;
  try {
    if (!force && !tracker.needsDetails(key)) return null;
    const r = await jira.getIssue(key);
    return tracker.setDetails(key, r, 'jira');
  } catch (err) {
    try {
      return tracker.setDetails(key, { error: `Could not reach Jira: ${err.message}` }, 'jira');
    } catch {
      return null;
    }
  }
}
