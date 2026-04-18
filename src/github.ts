// Thin GitHub Releases API client. Only reads public endpoints, never writes.

const REPO_OWNER = 'apps-in-toss-community';
const REPO_NAME = 'console-cli';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name: string;
  name: string | null;
  html_url: string;
  assets: ReleaseAsset[];
}

function defaultHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ait-console',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token && token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function fetchLatestRelease(): Promise<Release> {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
  const res = await fetch(url, { headers: defaultHeaders() });
  if (!res.ok) {
    throw new Error(`GitHub releases/latest returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Release;
}

// Parse `tag_name` into a comparable semver string. Changesets tags this repo
// as `@ait-co/console-cli@0.1.2`; older ad-hoc tags may be `v0.1.2`. We
// accept both.
export function versionFromTag(tag: string): string {
  const at = tag.lastIndexOf('@');
  const candidate = at >= 0 ? tag.slice(at + 1) : tag;
  return candidate.startsWith('v') ? candidate.slice(1) : candidate;
}
