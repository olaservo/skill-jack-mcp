#!/usr/bin/env node
/**
 * Skill Jack MCP - "I know kung fu."
 *
 * MCP server that jacks Agent Skills directly into your LLM's brain.
 * Provides global skills with tools for progressive disclosure.
 *
 * Usage:
 *   skill-jack-mcp /path/to/skills [/path2 ...]   # One or more directories
 *   SKILLS_DIR=/path/to/skills skill-jack-mcp    # Single directory via env
 *   SKILLS_DIR=/path1,/path2 skill-jack-mcp      # Multiple (comma-separated)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverSkills, generateInstructions, createSkillMap } from "./skill-discovery.js";
import { registerSkillTool, SkillState } from "./skill-tool.js";
import { registerSkillResources } from "./skill-resources.js";
import {
  createSubscriptionManager,
  registerSubscriptionHandlers,
} from "./subscriptions.js";

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
 * Get the skills directories from command line args and/or environment.
 * Returns deduplicated, resolved paths.
 */
function getSkillsDirs(): string[] {
  const dirs: string[] = [];

  // Collect all non-flag command-line arguments (comma-separated supported)
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      const paths = arg
        .split(PATH_LIST_SEPARATOR)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => path.resolve(p));
      dirs.push(...paths);
    }
  }

  // Also check environment variable (comma-separated supported)
  const envDir = process.env.SKILLS_DIR;
  if (envDir) {
    const envPaths = envDir
      .split(PATH_LIST_SEPARATOR)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => path.resolve(p));
    dirs.push(...envPaths);
  }

  // Deduplicate by resolved path
  return [...new Set(dirs)];
}

/**
 * Shared state for skill management.
 * Tools and resources reference this state.
 */
const skillState: SkillState = {
  skillMap: new Map(),
  instructions: "",
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
 * Subscription manager for resource file watching.
 */
const subscriptionManager = createSubscriptionManager();

async function main() {
  const skillsDirs = getSkillsDirs();

  if (skillsDirs.length === 0) {
    console.error("No skills directory configured.");
    console.error("Usage: skill-jack-mcp /path/to/skills [/path/to/more/skills ...]");
    console.error("   or: SKILLS_DIR=/path/to/skills skill-jack-mcp");
    console.error("   or: SKILLS_DIR=/path1,/path2 skill-jack-mcp");
    process.exit(1);
  }

  console.error(`Skills directories: ${skillsDirs.join(", ")}`);

  // Discover skills at startup
  const skills = discoverSkillsFromDirs(skillsDirs);
  skillState.skillMap = createSkillMap(skills);
  skillState.instructions = generateInstructions(skills);
  console.error(`Discovered ${skills.length} skill(s)`);

  // Create the MCP server
  const server = new McpServer(
    {
      name: "skill-jack-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: true },
      },
      instructions: skillState.instructions,
    }
  );

  // Register tools and resources
  registerSkillTool(server, skillState);
  registerSkillResources(server, skillState);

  // Register subscription handlers for resource file watching
  registerSubscriptionHandlers(server, skillState, subscriptionManager);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Skill Jack ready. I know kung fu.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
