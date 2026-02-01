#!/usr/bin/env node
/**
 * Skilljack MCP - "I know kung fu."
 *
 * MCP server that jacks Agent Skills directly into your LLM's brain.
 * Provides global skills with tools for progressive disclosure.
 *
 * Usage:
 *   skilljack-mcp /path/to/skills [/path2 ...]           # Local directories
 *   skilljack-mcp github.com/owner/repo                  # GitHub repository
 *   skilljack-mcp /local github.com/owner/repo           # Mixed local + GitHub
 *   SKILLS_DIR=/path,github.com/owner/repo skilljack-mcp # Via environment
 */

import { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import chokidar from "chokidar";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverSkills, createSkillMap } from "./skill-discovery.js";
import { registerSkillTool, getToolDescription, SkillState } from "./skill-tool.js";
import { registerSkillResources } from "./skill-resources.js";
import { registerSkillPrompts, refreshPrompts, PromptRegistry } from "./skill-prompts.js";
import {
  createSubscriptionManager,
  registerSubscriptionHandlers,
  refreshSubscriptions,
  SubscriptionManager,
} from "./subscriptions.js";
import {
  isGitHubUrl,
  parseGitHubUrl,
  isRepoAllowed,
  getGitHubConfig,
  GitHubRepoSpec,
  GitHubConfig,
} from "./github-config.js";
import { syncAllRepos, SyncOptions, SyncResult } from "./github-sync.js";
import { createPollingManager, PollingManager } from "./github-polling.js";

/**
 * Subdirectories to check for skills within the configured directory.
 */
const SKILL_SUBDIRS = [".claude/skills", "skills"];

/**
 * Separator for multiple paths in SKILLS_DIR environment variable.
 * Comma works cross-platform (not valid in file paths on any OS).
 */
const PATH_LIST_SEPARATOR = ",";

/**
 * Get all paths from command line args and/or environment.
 * Returns raw paths (not resolved) for classification.
 */
function getAllPaths(): string[] {
  const paths: string[] = [];

  // Collect all non-flag command-line arguments (comma-separated supported)
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      const argPaths = arg
        .split(PATH_LIST_SEPARATOR)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      paths.push(...argPaths);
    }
  }

  // Also check environment variable (comma-separated supported)
  const envDir = process.env.SKILLS_DIR;
  if (envDir) {
    const envPaths = envDir
      .split(PATH_LIST_SEPARATOR)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    paths.push(...envPaths);
  }

  return paths;
}

/**
 * Classify paths as local directories or GitHub repositories.
 * GitHub URLs are detected by checking for "github.com" in the path.
 */
function classifyPaths(paths: string[]): {
  localDirs: string[];
  githubSpecs: GitHubRepoSpec[];
} {
  const localDirs: string[] = [];
  const githubSpecs: GitHubRepoSpec[] = [];

  for (const p of paths) {
    if (isGitHubUrl(p)) {
      try {
        const spec = parseGitHubUrl(p);
        githubSpecs.push(spec);
      } catch (error) {
        console.error(`Warning: Invalid GitHub URL "${p}": ${error}`);
      }
    } else {
      // Local directory - resolve the path
      localDirs.push(path.resolve(p));
    }
  }

  // Deduplicate local dirs
  const uniqueLocalDirs = [...new Set(localDirs)];

  // Deduplicate GitHub specs by owner/repo
  const seenRepos = new Set<string>();
  const uniqueGithubSpecs = githubSpecs.filter((spec) => {
    const key = `${spec.owner}/${spec.repo}`;
    if (seenRepos.has(key)) {
      return false;
    }
    seenRepos.add(key);
    return true;
  });

  return { localDirs: uniqueLocalDirs, githubSpecs: uniqueGithubSpecs };
}

/**
 * Shared state for skill management.
 * Tools and resources reference this state.
 */
const skillState: SkillState = {
  skillMap: new Map(),
};

/**
 * Discover skills from multiple configured directories.
 * Each directory is checked along with its standard subdirectories.
 * Handles duplicate skill names by keeping first occurrence.
 */
function discoverSkillsFromDirs(skillsDirs: string[]): ReturnType<typeof discoverSkills> {
  const allSkills: ReturnType<typeof discoverSkills> = [];
  const seenNames = new Map<string, string>(); // name -> source directory

  for (const skillsDir of skillsDirs) {
    if (!fs.existsSync(skillsDir)) {
      console.error(`Warning: Skills directory not found: ${skillsDir}`);
      continue;
    }

    console.error(`Scanning skills directory: ${skillsDir}`);

    // Check if the directory itself contains skills
    const dirSkills = discoverSkills(skillsDir);

    // Also check standard subdirectories
    for (const subdir of SKILL_SUBDIRS) {
      const subPath = path.join(skillsDir, subdir);
      if (fs.existsSync(subPath)) {
        dirSkills.push(...discoverSkills(subPath));
      }
    }

    // Add skills, checking for duplicates
    for (const skill of dirSkills) {
      if (seenNames.has(skill.name)) {
        console.error(
          `Warning: Duplicate skill "${skill.name}" found in ${path.dirname(skill.path)} ` +
            `(already loaded from ${seenNames.get(skill.name)})`
        );
        continue; // Skip duplicate
      }
      seenNames.set(skill.name, path.dirname(skill.path));
      allSkills.push(skill);
    }
  }

  return allSkills;
}

/**
 * Debounce delay for skill directory changes (ms).
 * Multiple rapid changes are coalesced into one refresh.
 */
const SKILL_REFRESH_DEBOUNCE_MS = 500;

/**
 * Refresh skills and notify clients of changes.
 * Called when skill files change on disk.
 *
 * @param skillsDirs - The configured skill directories
 * @param server - The MCP server instance
 * @param skillTool - The registered skill tool to update
 * @param promptRegistry - For refreshing skill prompts
 * @param subscriptionManager - For refreshing resource subscriptions
 */
function refreshSkills(
  skillsDirs: string[],
  server: McpServer,
  skillTool: RegisteredTool,
  promptRegistry: PromptRegistry,
  subscriptionManager: SubscriptionManager
): void {
  console.error("Refreshing skills...");

  // Re-discover all skills
  const skills = discoverSkillsFromDirs(skillsDirs);
  const oldCount = skillState.skillMap.size;

  // Update shared state
  skillState.skillMap = createSkillMap(skills);

  console.error(`Skills refreshed: ${oldCount} -> ${skills.length} skill(s)`);

  // Update the skill tool description with new instructions
  skillTool.update({
    description: getToolDescription(skillState),
  });

  // Refresh prompts to match new skill state
  refreshPrompts(server, skillState, promptRegistry);

  // Refresh resource subscriptions to match new skill state
  refreshSubscriptions(subscriptionManager, skillState, (uri) => {
    server.server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    });
  });

  // Notify clients that tools have changed
  // This prompts clients to call tools/list again
  server.sendToolListChanged();

  // Also notify that resources have changed
  server.sendResourceListChanged();
}

/**
 * Set up file watchers on skill directories to detect changes.
 * Watches for SKILL.md additions, modifications, and deletions.
 *
 * @param skillsDirs - The configured skill directories
 * @param server - The MCP server instance
 * @param skillTool - The registered skill tool to update
 * @param promptRegistry - For refreshing skill prompts
 * @param subscriptionManager - For refreshing subscriptions
 */
function watchSkillDirectories(
  skillsDirs: string[],
  server: McpServer,
  skillTool: RegisteredTool,
  promptRegistry: PromptRegistry,
  subscriptionManager: SubscriptionManager
): void {
  let refreshTimeout: NodeJS.Timeout | null = null;

  const debouncedRefresh = () => {
    if (refreshTimeout) {
      clearTimeout(refreshTimeout);
    }
    refreshTimeout = setTimeout(() => {
      refreshTimeout = null;
      refreshSkills(skillsDirs, server, skillTool, promptRegistry, subscriptionManager);
    }, SKILL_REFRESH_DEBOUNCE_MS);
  };

  // Build list of paths to watch
  const watchPaths: string[] = [];
  for (const dir of skillsDirs) {
    if (fs.existsSync(dir)) {
      watchPaths.push(dir);
      // Also watch standard subdirectories
      for (const subdir of SKILL_SUBDIRS) {
        const subPath = path.join(dir, subdir);
        if (fs.existsSync(subPath)) {
          watchPaths.push(subPath);
        }
      }
    }
  }

  if (watchPaths.length === 0) {
    console.error("No skill directories to watch");
    return;
  }

  console.error(`Watching for skill changes in: ${watchPaths.join(", ")}`);

  const watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    depth: 2, // Watch skill subdirectories but not too deep
    ignored: ["**/node_modules/**", "**/.git/**"],
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  // Watch for SKILL.md changes specifically
  watcher.on("add", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill added: ${filePath}`);
      debouncedRefresh();
    }
  });

  watcher.on("change", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill modified: ${filePath}`);
      debouncedRefresh();
    }
  });

  watcher.on("unlink", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill removed: ${filePath}`);
      debouncedRefresh();
    }
  });

  // Also watch for directory additions (new skill folders)
  watcher.on("addDir", (dirPath) => {
    // Check if this might be a new skill directory
    const skillMdPath = path.join(dirPath, "SKILL.md");
    const skillMdPathLower = path.join(dirPath, "skill.md");
    if (fs.existsSync(skillMdPath) || fs.existsSync(skillMdPathLower)) {
      console.error(`Skill directory added: ${dirPath}`);
      debouncedRefresh();
    }
  });

  watcher.on("unlinkDir", (dirPath) => {
    // A skill directory was removed
    console.error(`Directory removed: ${dirPath}`);
    debouncedRefresh();
  });
}

/**
 * Subscription manager for resource file watching.
 */
const subscriptionManager = createSubscriptionManager();

async function main() {
  const allPaths = getAllPaths();

  if (allPaths.length === 0) {
    console.error("No skills source configured.");
    console.error("Usage: skilljack-mcp /path/to/skills [github.com/owner/repo ...]");
    console.error("   or: SKILLS_DIR=/path/to/skills skilljack-mcp");
    console.error("   or: SKILLS_DIR=github.com/owner/repo skilljack-mcp");
    console.error("");
    console.error("Examples:");
    console.error("  skilljack-mcp /local/skills                    # Local directory");
    console.error("  skilljack-mcp github.com/olaservo/my-skills    # GitHub repo");
    console.error("  skilljack-mcp github.com/org/repo@v1.0.0       # Pinned version");
    console.error("  skilljack-mcp github.com/org/mono/skills       # Monorepo subpath");
    process.exit(1);
  }

  // Classify paths as local or GitHub
  const { localDirs, githubSpecs } = classifyPaths(allPaths);

  // Get GitHub configuration
  const githubConfig = getGitHubConfig();

  // Sync GitHub repositories
  let githubDirs: string[] = [];
  let allowedGithubSpecs: GitHubRepoSpec[] = [];

  if (githubSpecs.length > 0) {
    console.error(`GitHub repos: ${githubSpecs.map((s) => `${s.owner}/${s.repo}`).join(", ")}`);

    // Filter by allowlist
    for (const spec of githubSpecs) {
      if (!isRepoAllowed(spec, githubConfig)) {
        console.error(
          `Blocked: ${spec.owner}/${spec.repo} not in allowed orgs/users. ` +
            `Set GITHUB_ALLOWED_ORGS or GITHUB_ALLOWED_USERS to permit.`
        );
        continue;
      }
      allowedGithubSpecs.push(spec);
    }

    if (allowedGithubSpecs.length > 0) {
      console.error(`Syncing ${allowedGithubSpecs.length} GitHub repo(s)...`);

      const syncOptions: SyncOptions = {
        cacheDir: githubConfig.cacheDir,
        token: githubConfig.token,
        shallowClone: true,
      };

      const results = await syncAllRepos(allowedGithubSpecs, syncOptions);

      // Collect successful sync paths
      for (const result of results) {
        if (!result.error) {
          githubDirs.push(result.localPath);
        }
      }

      console.error(`Successfully synced ${githubDirs.length}/${allowedGithubSpecs.length} repo(s)`);
    }
  }

  // Combine all skill directories
  const skillsDirs = [...localDirs, ...githubDirs];

  if (skillsDirs.length === 0) {
    console.error("No valid skills directories available.");
    process.exit(1);
  }

  if (localDirs.length > 0) {
    console.error(`Local directories: ${localDirs.join(", ")}`);
  }
  if (githubDirs.length > 0) {
    console.error(`GitHub cache directories: ${githubDirs.join(", ")}`);
  }

  // Discover skills at startup
  const skills = discoverSkillsFromDirs(skillsDirs);
  skillState.skillMap = createSkillMap(skills);
  console.error(`Discovered ${skills.length} skill(s)`);

  // Create the MCP server
  const server = new McpServer(
    {
      name: "skilljack-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
      },
    }
  );

  // Register tools, resources, and prompts
  const skillTool = registerSkillTool(server, skillState);
  registerSkillResources(server, skillState);
  const promptRegistry = registerSkillPrompts(server, skillState);

  // Register subscription handlers for resource file watching
  registerSubscriptionHandlers(server, skillState, subscriptionManager);

  // Set up file watchers for skill directory changes
  watchSkillDirectories(skillsDirs, server, skillTool, promptRegistry, subscriptionManager);

  // Set up GitHub polling for updates
  let pollingManager: PollingManager | null = null;
  if (allowedGithubSpecs.length > 0 && githubConfig.pollIntervalMs > 0) {
    const syncOptions: SyncOptions = {
      cacheDir: githubConfig.cacheDir,
      token: githubConfig.token,
      shallowClone: true,
    };

    pollingManager = createPollingManager(allowedGithubSpecs, syncOptions, {
      intervalMs: githubConfig.pollIntervalMs,
      onUpdate: (spec, result) => {
        console.error(`GitHub update detected for ${spec.owner}/${spec.repo}`);
        refreshSkills(skillsDirs, server, skillTool, promptRegistry, subscriptionManager);
      },
      onError: (spec, error) => {
        console.error(`GitHub polling error for ${spec.owner}/${spec.repo}: ${error.message}`);
      },
    });

    pollingManager.start();
  }

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Skilljack ready. I know kung fu.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
