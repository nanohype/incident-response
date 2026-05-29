/**
 * GitHub client for CODEOWNERS lookup and recent deploy timeline.
 */

import { HttpClient } from '../utils/http-client.js';
import { logger } from '../utils/logger.js';

export interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  timestamp: string;
  url: string;
}
export interface CodeOwnersEntry {
  pattern: string;
  owners: string[];
}

interface GitHubAPICommit {
  sha: string;
  html_url: string;
  commit: { message: string; author?: { name: string; date: string } };
  author?: { login: string };
}

export class GitHubClient {
  private readonly http: HttpClient;

  constructor(
    token: string,
    private readonly orgSlug: string,
  ) {
    this.http = new HttpClient({
      clientName: 'github',
      baseUrl: 'https://api.github.com',
      defaultHeaders: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'marshal-incident-bot/0.1.0',
      },
      timeoutMs: 5000,
      maxRetries: 2,
    });
  }

  async getRecentCommits(repoName: string, incidentId: string): Promise<GitHubCommit[]> {
    logger.debug({ incident_id: incidentId, repo: repoName }, 'Querying GitHub recent commits');
    const since = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    const resp = await this.http.get<GitHubAPICommit[]>(
      `/repos/${this.orgSlug}/${repoName}/commits?per_page=5&since=${encodeURIComponent(since)}`,
    );
    if (!resp.ok) {
      logger.warn({ repo: repoName, status: resp.status }, 'GitHub commits query failed');
      return [];
    }
    return resp.data.map((c) => ({
      sha: c.sha.substring(0, 8),
      message: c.commit.message.split('\n')[0] ?? '',
      author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
      timestamp: c.commit.author?.date ?? '',
      url: c.html_url,
    }));
  }

  async getCodeOwners(repoName: string, incidentId: string): Promise<CodeOwnersEntry[]> {
    logger.debug({ incident_id: incidentId, repo: repoName }, 'Querying GitHub CODEOWNERS');
    for (const filePath of ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) {
      const resp = await this.http.get<{ content: string; encoding: string }>(`/repos/${this.orgSlug}/${repoName}/contents/${filePath}`);
      if (!resp.ok) continue;
      const content = Buffer.from(resp.data.content, 'base64').toString('utf8');
      return content
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#'))
        .map((l) => {
          const parts = l.trim().split(/\s+/);
          return { pattern: parts[0] ?? '', owners: parts.slice(1).filter((p) => p.startsWith('@')) };
        })
        .filter((e) => e.pattern && e.owners.length > 0);
    }
    return [];
  }
}
