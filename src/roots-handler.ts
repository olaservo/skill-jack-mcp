/**
 * MCP Roots handler for dynamic skill discovery.
 *
 * Requests roots from the client, scans for skills in each root,
 * and handles root change notifications.
 *
 * Pattern adapted from:
 * - .claude/skills/mcp-server-ts/snippets/server/index.ts (oninitialized, syncRoots)
 * - .claude/skills/mcp-client-ts/snippets/handlers/roots.ts (URI conversion)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverSkills,
  SkillMetadata,
  generateInstructions,
  createSkillMap,
} from "./skill-discovery.js";

/**
 * Skill discovery locations within each root.
 */
export const SKILL_SUBDIRS = [".claude/skills", "skills"];

/**
 * Convert a file:// URI to a filesystem path.
 * Adapted from mcp-client-ts roots.ts pathToRoot() (reverse direction).
 */
function uriToPath(uri: string): string {
  return fileURLToPath(new URL(uri));
}

/**
 * Discover skills from all roots provided by the client.
 *
 * Scans each root for skill directories (.claude/skills/, skills/)
 * and handles naming conflicts by prefixing with root name.
 *
 * @param roots - Array of Root objects from client's roots/list response
 * @returns Object containing discovered skills
 */
export function discoverSkillsFromRoots(
  roots: Array<{ uri: string; name?: string }>
): { skills: SkillMetadata[]; rootSources: Map<string, string> } {
  const allSkills: SkillMetadata[] = [];
  const rootSources = new Map<string, string>(); // skill path -> root name
  const nameCount = new Map<string, number>(); // track duplicates

  for (const root of roots) {
    let rootPath: string;
    try {
      rootPath = uriToPath(root.uri);
    } catch (error) {
      console.error(`Failed to parse root URI "${root.uri}":`, error);
      continue;
    }

    const rootName = root.name || path.basename(rootPath);

    for (const subdir of SKILL_SUBDIRS) {
      const skillsDir = path.join(rootPath, subdir);

      if (fs.existsSync(skillsDir)) {
        try {
          const skills = discoverSkills(skillsDir);

          for (const skill of skills) {
            // Track which root this skill came from
            rootSources.set(skill.path, rootName);

            // Count occurrences of each name
            const count = (nameCount.get(skill.name) || 0) + 1;
            nameCount.set(skill.name, count);

            allSkills.push(skill);
          }
        } catch (error) {
          console.error(`Failed to discover skills in "${skillsDir}":`, error);
        }
      }
    }
  }

  // Handle naming conflicts by prefixing duplicates with root name
  for (const skill of allSkills) {
    if (nameCount.get(skill.name)! > 1) {
      const rootName = rootSources.get(skill.path)!;
      skill.name = `${rootName}:${skill.name}`;
    }
  }

  return { skills: allSkills, rootSources };
}

/**
 * Callback type for when skills are updated.
 */
export type SkillsChangedCallback = (
  skillMap: Map<string, SkillMetadata>,
  instructions: string
) => void;

/**
 * Sync skills from roots or fallback directory.
 *
 * Pattern from mcp-server-ts snippets/server/index.ts:
 * - Check client capabilities
 * - Request roots if supported
 * - Fall back to directory if not
 *
 * @param server - The McpServer instance
 * @param fallbackDir - Optional fallback directory if client doesn't support roots
 * @param onSkillsChanged - Callback when skills are updated
 */
export async function syncSkills(
  server: McpServer,
  fallbackDir: string | null,
  onSkillsChanged: SkillsChangedCallback
): Promise<void> {
  const capabilities = server.server.getClientCapabilities();

  if (capabilities?.roots) {
    // Client supports roots - request them
    console.error("Client supports roots, requesting workspace roots...");

    try {
      const { roots } = await server.server.listRoots();
      console.error(`Received ${roots.length} root(s) from client`);

      const { skills } = discoverSkillsFromRoots(roots);
      console.error(`Discovered ${skills.length} skill(s) from roots`);

      // If no skills found from roots, try fallback directory
      if (skills.length === 0 && fallbackDir) {
        console.error("No skills found from roots, trying fallback directory...");
        useFallbackDirectory(fallbackDir, onSkillsChanged);
      } else {
        const skillMap = createSkillMap(skills);
        const instructions = generateInstructions(skills);
        onSkillsChanged(skillMap, instructions);
      }

      // Listen for roots changes if client supports listChanged
      if (capabilities.roots.listChanged) {
        setupRootsChangeHandler(server, fallbackDir, onSkillsChanged);
      }
    } catch (error) {
      console.error("Failed to get roots from client:", error);
      // Fall through to fallback
      useFallbackDirectory(fallbackDir, onSkillsChanged);
    }
  } else {
    // Client doesn't support roots - use fallback
    console.error("Client does not support roots, using fallback directory");
    useFallbackDirectory(fallbackDir, onSkillsChanged);
  }
}

/**
 * Set up handler for roots/list_changed notifications.
 */
function setupRootsChangeHandler(
  server: McpServer,
  fallbackDir: string | null,
  onSkillsChanged: SkillsChangedCallback
): void {
  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => {
      console.error("Roots changed notification received, re-discovering skills...");

      try {
        const { roots } = await server.server.listRoots();
        const { skills } = discoverSkillsFromRoots(roots);

        console.error(`Re-discovered ${skills.length} skill(s) from updated roots`);

        const skillMap = createSkillMap(skills);
        const instructions = generateInstructions(skills);

        onSkillsChanged(skillMap, instructions);

        // Notify client that resources have changed
        await server.server.notification({
          method: "notifications/resources/list_changed",
        });
      } catch (error) {
        console.error("Failed to re-discover skills after roots change:", error);
      }
    }
  );
}

/**
 * Use the fallback directory when roots are unavailable.
 * Checks both the directory itself and SKILL_SUBDIRS subdirectories
 * to match roots discovery behavior.
 */
function useFallbackDirectory(
  fallbackDir: string | null,
  onSkillsChanged: SkillsChangedCallback
): void {
  if (!fallbackDir) {
    console.error("No fallback directory configured, no skills available");
    onSkillsChanged(new Map(), generateInstructions([]));
    return;
  }

  console.error(`Using fallback skills directory: ${fallbackDir}`);

  try {
    const allSkills: SkillMetadata[] = [];

    // First, check if the fallback directory itself contains skills
    // (for backwards compatibility when user passes the exact skills folder)
    const directSkills = discoverSkills(fallbackDir);
    allSkills.push(...directSkills);

    // Also check SKILL_SUBDIRS subdirectories (matching roots discovery behavior)
    for (const subdir of SKILL_SUBDIRS) {
      const skillsDir = path.join(fallbackDir, subdir);
      if (fs.existsSync(skillsDir)) {
        const subdirSkills = discoverSkills(skillsDir);
        allSkills.push(...subdirSkills);
      }
    }

    console.error(`Found ${allSkills.length} skill(s) in fallback directory`);

    const skillMap = createSkillMap(allSkills);
    const instructions = generateInstructions(allSkills);

    onSkillsChanged(skillMap, instructions);
  } catch (error) {
    console.error(`Failed to discover skills in fallback directory:`, error);
    onSkillsChanged(new Map(), generateInstructions([]));
  }
}
