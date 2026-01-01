#!/usr/bin/env node
/**
 * Skill Jack MCP - "I know kung fu."
 *
 * MCP server that jacks Agent Skills directly into your LLM's brain.
 * Now with MCP Roots support for dynamic workspace skill discovery.
 *
 * Usage:
 *   skill-jack-mcp                    # Uses roots from client
 *   skill-jack-mcp /path/to/skills    # Fallback directory
 *   SKILLS_DIR=/path/to/skills skill-jack-mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "node:path";
import { generateInstructions } from "./skill-discovery.js";
import { registerSkillTool, SkillState } from "./skill-tool.js";
import { registerSkillResources } from "./skill-resources.js";
import { syncSkills } from "./roots-handler.js";

/**
 * Get the fallback skills directory from command line args or environment.
 * This is now optional - skills can be discovered from client roots.
 */
function getFallbackSkillsDir(): string | null {
  // Check command line argument first
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] && !args[0].startsWith("-")) {
    return path.resolve(args[0]);
  }

  // Fall back to environment variable
  const envDir = process.env.SKILLS_DIR;
  if (envDir) {
    return path.resolve(envDir);
  }

  return null;
}

/**
 * Shared state for dynamic skill management.
 * Tools and resources reference this state, allowing updates when roots change.
 */
const skillState: SkillState = {
  skillMap: new Map(),
  instructions: "",
};

async function main() {
  const fallbackSkillsDir = getFallbackSkillsDir();

  // Log startup mode
  if (fallbackSkillsDir) {
    console.error(`Fallback skills directory: ${fallbackSkillsDir}`);
  } else {
    console.error("No fallback skills directory configured (will use roots only)");
  }

  // Create the MCP server with initial empty instructions
  // Instructions will be updated when skills are discovered
  const server = new McpServer(
    {
      name: "skill-jack-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: { listChanged: true },
      },
      // Start with minimal instructions; updated after roots discovery
      instructions: generateInstructions([]),
    }
  );

  // Register tools and resources that reference the shared skillState
  // These will use the current skillMap, which gets updated dynamically
  registerSkillTool(server, skillState);
  registerSkillResources(server, skillState);

  // Set up post-initialization handler for roots discovery
  // Pattern from .claude/skills/mcp-server-ts/snippets/server/index.ts
  server.server.oninitialized = async () => {
    // Delay to ensure notifications/initialized handler finishes
    // (per MCP reference implementation)
    setTimeout(() => {
      syncSkills(server, fallbackSkillsDir, (newSkillMap, newInstructions) => {
        // Update shared state
        skillState.skillMap = newSkillMap;
        skillState.instructions = newInstructions;

        const skillNames = Array.from(newSkillMap.keys());
        console.error(
          `Skills updated: ${skillNames.join(", ") || "none"}`
        );
      });
    }, 350);
  };

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Skill Jack ready. I know kung fu.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
