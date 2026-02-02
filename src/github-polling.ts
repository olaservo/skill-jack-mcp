/**
 * GitHub repository polling for updates.
 * Periodically checks for changes and triggers sync when updates are available.
 */

import { GitHubRepoSpec } from "./github-config.js";
import { SyncOptions, SyncResult, syncRepo, hasRemoteUpdates } from "./github-sync.js";

/**
 * Options for the polling manager.
 */
export interface PollingOptions {
  intervalMs: number;
  onUpdate: (spec: GitHubRepoSpec, result: SyncResult) => void;
  onError?: (spec: GitHubRepoSpec, error: Error) => void;
}

/**
 * Polling manager interface.
 */
export interface PollingManager {
  start(): void;
  stop(): void;
  checkNow(): Promise<void>;
  isRunning(): boolean;
}

/**
 * Create a polling manager for GitHub repositories.
 *
 * The manager periodically checks for updates and syncs repositories
 * when changes are detected. Pinned refs (tags, commits) are skipped.
 *
 * @param specs - Repository specifications to poll
 * @param syncOptions - Options for sync operations
 * @param pollingOptions - Polling configuration
 * @returns Polling manager
 */
export function createPollingManager(
  specs: GitHubRepoSpec[],
  syncOptions: SyncOptions,
  pollingOptions: PollingOptions
): PollingManager {
  let intervalId: NodeJS.Timeout | null = null;
  let isChecking = false;

  /**
   * Filter specs to only include those that should be polled.
   * Pinned refs (tags, commits) are excluded.
   */
  function getPolledSpecs(): GitHubRepoSpec[] {
    return specs.filter((spec) => {
      if (!spec.ref) {
        return true; // No ref means default branch, poll it
      }
      // Exclude what looks like a tag version or commit hash
      const isVersionTag = /^v?\d+(\.\d+)*/.test(spec.ref);
      const isCommitHash = /^[0-9a-f]{7,40}$/i.test(spec.ref);
      return !isVersionTag && !isCommitHash;
    });
  }

  /**
   * Check all repositories for updates.
   */
  async function checkForUpdates(): Promise<void> {
    if (isChecking) {
      console.error("Polling: Already checking for updates, skipping...");
      return;
    }

    isChecking = true;
    const polledSpecs = getPolledSpecs();

    if (polledSpecs.length === 0) {
      console.error("Polling: No repositories to poll (all pinned to specific refs)");
      isChecking = false;
      return;
    }

    console.error(`Polling: Checking ${polledSpecs.length} repo(s) for updates...`);

    for (const spec of polledSpecs) {
      try {
        const hasUpdates = await hasRemoteUpdates(spec, syncOptions);

        if (hasUpdates) {
          console.error(`Polling: Updates available for ${spec.owner}/${spec.repo}`);
          const result = await syncRepo(spec, syncOptions);

          if (!result.error && result.updated) {
            pollingOptions.onUpdate(spec, result);
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`Polling: Error checking ${spec.owner}/${spec.repo}: ${err.message}`);
        pollingOptions.onError?.(spec, err);
      }
    }

    isChecking = false;
  }

  return {
    start(): void {
      if (intervalId !== null) {
        console.error("Polling: Already running");
        return;
      }

      if (pollingOptions.intervalMs <= 0) {
        console.error("Polling: Disabled (interval <= 0)");
        return;
      }

      const polledSpecs = getPolledSpecs();
      if (polledSpecs.length === 0) {
        console.error("Polling: Not starting (all repos pinned to specific refs)");
        return;
      }

      console.error(
        `Polling: Starting with ${pollingOptions.intervalMs}ms interval ` +
          `for ${polledSpecs.length} repo(s)`
      );

      intervalId = setInterval(() => {
        checkForUpdates().catch((error) => {
          console.error(`Polling: Unexpected error: ${error}`);
        });
      }, pollingOptions.intervalMs);
    },

    stop(): void {
      if (intervalId === null) {
        return;
      }

      console.error("Polling: Stopping");
      clearInterval(intervalId);
      intervalId = null;
    },

    async checkNow(): Promise<void> {
      await checkForUpdates();
    },

    isRunning(): boolean {
      return intervalId !== null;
    },
  };
}
