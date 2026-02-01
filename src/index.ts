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
 *   (or configure local directories via the skill-config UI)
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
import { getActiveDirectories } from "./skill-config.js";
import { registerSkillConfigTool } from "./skill-config-tool.js";
import {
  isGitHubUrl,
  parseGitHubUrl,
  isRepoAllowed,
  getGitHubConfig,
  GitHubRepoSpec,
} from "./github-config.js";
import { syncAllRepos, SyncOptions } from "./github-sync.js";
import { createPollingManager, PollingManager } from "./github-polling.js";

/**
 * Subdirectories to check for skills within the configured directory.
 */
const SKILL_SUBDIRS = [".claude/skills", "skills"];

/**
 * Current skill directories (mutable to support UI-driven changes).
 * This includes both local directories and GitHub cache directories.
 */
let currentSkillsDirs: string[] = [];

/**
 * GitHub specs that are currently being polled.
 */
let currentGithubSpecs: GitHubRepoSpec[] = [];

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
  // Get skill directories from CLI args, env var, or config file
  // This returns paths that may include GitHub URLs
  const allPaths = getActiveDirectories();

  // Classify paths as local or GitHub
  const { localDirs, githubSpecs } = classifyPaths(allPaths);

  // Get GitHub configuration
  const githubConfig = getGitHubConfig();

  // Sync GitHub repositories
  let githubDirs: string[] = [];

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
      currentGithubSpecs.push(spec);
    }

    if (currentGithubSpecs.length > 0) {
      console.error(`Syncing ${currentGithubSpecs.length} GitHub repo(s)...`);

      const syncOptions: SyncOptions = {
        cacheDir: githubConfig.cacheDir,
        token: githubConfig.token,
        shallowClone: true,
      };

      const results = await syncAllRepos(currentGithubSpecs, syncOptions);

      // Collect successful sync paths
      for (const result of results) {
        if (!result.error) {
          githubDirs.push(result.localPath);
        }
      }

      console.error(`Successfully synced ${githubDirs.length}/${currentGithubSpecs.length} repo(s)`);
    }
  }

  // Combine all skill directories
  currentSkillsDirs = [...localDirs, ...githubDirs];

  // Allow starting with no directories - user can configure via UI
  if (currentSkillsDirs.length === 0) {
    console.error("No skills directories configured.");
    console.error("You can configure directories via the skill-config tool UI,");
    console.error("or use CLI args: skilljack-mcp /path/to/skills");
    console.error("or use GitHub: skilljack-mcp github.com/owner/repo");
    console.error("or set SKILLS_DIR environment variable.");
  } else {
    if (localDirs.length > 0) {
      console.error(`Local directories: ${localDirs.join(", ")}`);
    }
    if (githubDirs.length > 0) {
      console.error(`GitHub cache directories: ${githubDirs.join(", ")}`);
    }
  }

  // Discover skills at startup
  const skills = discoverSkillsFromDirs(currentSkillsDirs);
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

  // Register skill-config tool for UI-based directory configuration
  registerSkillConfigTool(server, skillState, () => {
    // Callback when directories change via UI
    // Reload directories from config and refresh skills
    // Note: UI only manages local directories, GitHub repos are managed via CLI/env
    const newPaths = getActiveDirectories();
    const { localDirs: newLocalDirs } = classifyPaths(newPaths);
    currentSkillsDirs = [...newLocalDirs, ...githubDirs];
    console.error(`Directories changed via UI. New directories: ${currentSkillsDirs.join(", ") || "(none)"}`);
    refreshSkills(currentSkillsDirs, server, skillTool, promptRegistry, subscriptionManager);
  });

  // Set up file watchers for skill directory changes
  if (currentSkillsDirs.length > 0) {
    watchSkillDirectories(currentSkillsDirs, server, skillTool, promptRegistry, subscriptionManager);
  }

  // Set up GitHub polling for updates
  let pollingManager: PollingManager | null = null;
  if (currentGithubSpecs.length > 0 && githubConfig.pollIntervalMs > 0) {
    const syncOptions: SyncOptions = {
      cacheDir: githubConfig.cacheDir,
      token: githubConfig.token,
      shallowClone: true,
    };

    pollingManager = createPollingManager(currentGithubSpecs, syncOptions, {
      intervalMs: githubConfig.pollIntervalMs,
      onUpdate: (spec, result) => {
        console.error(`GitHub update detected for ${spec.owner}/${spec.repo}`);
        refreshSkills(currentSkillsDirs, server, skillTool, promptRegistry, subscriptionManager);
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
