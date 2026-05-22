export interface OpenDesignGithubRepoResponse {
  repo: string;
  stargazers_count: number;
  fetchedAt: string;
  stale: boolean;
}

export interface OpenDesignGithubLatestReleaseResponse {
  repo: string;
  tag_name: string;
  html_url: string;
  fetchedAt: string;
  stale: boolean;
}
