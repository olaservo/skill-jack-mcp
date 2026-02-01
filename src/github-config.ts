/**
 * GitHub configuration parsing and URL detection.
 * Handles detection of GitHub URLs, parsing repo specs, and allowlist validation.
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * Parsed GitHub repository specification.
 */
export interface GitHubRepoSpec {
  owner: string;
  repo: string;
  ref?: string; // branch, tag, or commit
  subpath?: string; // subdirectory within repo
}

/**
 * GitHub-specific configuration from environment variables.
 */
export interface GitHubConfig {
  token?: string;
  pollIntervalMs: number;
  cacheDir: string;
  allowedOrgs: string[];
  allowedUsers: string[];
}

/**
 * Default polling interval: 5 minutes.
 */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Default cache directory.
 */
const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".skilljack", "github-cache");

/**
 * Check if a path is a GitHub URL.
 * Detects paths containing "github.com".
 */
export function isGitHubUrl(urlOrPath: string): boolean {
  return urlOrPath.toLowerCase().includes("github.com");
}

/**
 * Parse a GitHub URL into a GitHubRepoSpec.
 *
 * Supported formats:
 *   github.com/owner/repo
 *   github.com/owner/repo@ref
 *   github.com/owner/repo/subpath
 *   github.com/owner/repo/subpath@ref
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *
 * @param url - The GitHub URL to parse
 * @returns Parsed GitHubRepoSpec
 * @throws Error if URL format is invalid
 */
export function parseGitHubUrl(url: string): GitHubRepoSpec {
  // Remove protocol prefix if present
  let normalized = url.replace(/^https?:\/\//, "");

  // Remove github.com prefix
  normalized = normalized.replace(/^github\.com\//i, "");

  // Remove trailing .git if present
  normalized = normalized.replace(/\.git$/, "");

  // Extract ref if present (everything after @)
  let ref: string | undefined;
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex !== -1) {
    ref = normalized.slice(atIndex + 1);
    normalized = normalized.slice(0, atIndex);
  }

  // Split remaining path: owner/repo[/subpath...]
  const parts = normalized.split("/").filter((p) => p.length > 0);

  if (parts.length < 2) {
    throw new Error(
      `Invalid GitHub URL: "${url}". Expected format: github.com/owner/repo[/subpath][@ref]`
    );
  }

  const owner = parts[0];
  const repo = parts[1];
  const subpath = parts.length > 2 ? parts.slice(2).join("/") : undefined;

  return { owner, repo, ref, subpath };
}

/**
 * Check if a repository is allowed by the allowlist.
 * If no allowlist is configured (both allowedOrgs and allowedUsers empty),
 * all repos are allowed.
 *
 * @param spec - The repository specification
 * @param config - GitHub configuration with allowlists
 * @returns true if allowed, false if blocked
 */
export function isRepoAllowed(spec: GitHubRepoSpec, config: GitHubConfig): boolean {
  // If no allowlist configured, allow all
  if (config.allowedOrgs.length === 0 && config.allowedUsers.length === 0) {
    return true;
  }

  const ownerLower = spec.owner.toLowerCase();

  // Check if owner is in allowed orgs
  if (config.allowedOrgs.some((org) => org.toLowerCase() === ownerLower)) {
    return true;
  }

  // Check if owner is in allowed users
  if (config.allowedUsers.some((user) => user.toLowerCase() === ownerLower)) {
    return true;
  }

  return false;
}

/**
 * Parse a comma-separated list from an environment variable.
 */
function parseCommaList(envValue: string | undefined): string[] {
  if (!envValue) {
    return [];
  }
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Get GitHub configuration from environment variables.
 *
 * Environment variables:
 *   GITHUB_TOKEN - Authentication token for private repos
 *   GITHUB_POLL_INTERVAL_MS - Polling interval (0 to disable, default 300000)
 *   SKILLJACK_CACHE_DIR - Cache directory (default ~/.skilljack/github-cache)
 *   GITHUB_ALLOWED_ORGS - Comma-separated list of allowed organizations
 *   GITHUB_ALLOWED_USERS - Comma-separated list of allowed users
 */
export function getGitHubConfig(): GitHubConfig {
  const pollIntervalStr = process.env.GITHUB_POLL_INTERVAL_MS;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  if (pollIntervalStr !== undefined) {
    const parsed = parseInt(pollIntervalStr, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      pollIntervalMs = parsed;
    }
  }

  return {
    token: process.env.GITHUB_TOKEN,
    pollIntervalMs,
    cacheDir: process.env.SKILLJACK_CACHE_DIR || DEFAULT_CACHE_DIR,
    allowedOrgs: parseCommaList(process.env.GITHUB_ALLOWED_ORGS),
    allowedUsers: parseCommaList(process.env.GITHUB_ALLOWED_USERS),
  };
}

/**
 * Get the local cache path for a GitHub repository.
 *
 * @param spec - The repository specification
 * @param cacheDir - Base cache directory
 * @returns Full path to the cached repository (including subpath if specified)
 */
export function getRepoCachePath(spec: GitHubRepoSpec, cacheDir: string): string {
  const repoPath = path.join(cacheDir, spec.owner, spec.repo);
  if (spec.subpath) {
    return path.join(repoPath, spec.subpath);
  }
  return repoPath;
}

/**
 * Get the local clone path for a GitHub repository (without subpath).
 * This is where the git repository is cloned to.
 *
 * @param spec - The repository specification
 * @param cacheDir - Base cache directory
 * @returns Full path to the cloned repository root
 */
export function getRepoClonePath(spec: GitHubRepoSpec, cacheDir: string): string {
  return path.join(cacheDir, spec.owner, spec.repo);
}
