/**
 * MCP Resource registration for skill-based resources.
 *
 * Resources provide application-controlled access to skill content,
 * complementing the model-controlled tool access.
 *
 * All resources use templates with dynamic list callbacks to support
 * skill updates when MCP roots change.
 *
 * URI Scheme:
 *   skill://                    -> Collection: all SKILL.md contents
 *   skill://{skillName}         -> SKILL.md content (template)
 *   skill://{skillName}/        -> Collection: all files in skill
 *   skill://{skillName}/{path}  -> File within skill directory (template)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SkillMetadata, loadSkillContent } from "./skill-discovery.js";
import { isPathWithinBase, listSkillFiles, MAX_FILE_SIZE, SkillState } from "./skill-tool.js";

/**
 * Get MIME type based on file extension.
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".md": "text/markdown",
    ".ts": "text/typescript",
    ".js": "text/javascript",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".txt": "text/plain",
    ".sh": "text/x-shellscript",
    ".py": "text/x-python",
    ".css": "text/css",
    ".html": "text/html",
    ".xml": "application/xml",
  };
  return mimeTypes[ext] || "text/plain";
}

/**
 * Register skill resources with the MCP server.
 *
 * All resources use templates with dynamic list callbacks to support
 * skill updates when MCP roots change.
 *
 * @param server - The McpServer instance
 * @param skillState - Shared state object (allows dynamic updates)
 */
export function registerSkillResources(
  server: McpServer,
  skillState: SkillState
): void {
  // Register collection resource for all skills
  registerAllSkillsCollection(server, skillState);

  // Register template for individual skill SKILL.md files
  registerSkillTemplate(server, skillState);

  // Register resource template for skill files
  registerSkillFileTemplate(server, skillState);
}

/**
 * Register a collection resource that returns all skills at once.
 *
 * URI: skill://
 *
 * Returns multiple ResourceContents, one per skill, each with its own URI.
 * This allows clients to fetch all skill content in a single request.
 */
function registerAllSkillsCollection(
  server: McpServer,
  skillState: SkillState
): void {
  server.registerResource(
    "All Skills",
    "skill://",
    {
      mimeType: "text/markdown",
      description: "Collection of all available skills. Returns all SKILL.md contents in one request.",
    },
    async () => {
      const contents = [];

      for (const [name, skill] of skillState.skillMap) {
        try {
          const content = loadSkillContent(skill.path);
          contents.push({
            uri: `skill://${encodeURIComponent(name)}`,
            mimeType: "text/markdown",
            text: content,
          });
        } catch (error) {
          // Skip skills that fail to load, but continue with others
          console.error(`Failed to load skill "${name}":`, error);
        }
      }

      return { contents };
    }
  );
}

/**
 * Register a template for individual skill SKILL.md resources.
 *
 * URI Pattern: skill://{skillName}
 *
 * Uses a template with a list callback to dynamically return available skills.
 */
function registerSkillTemplate(
  server: McpServer,
  skillState: SkillState
): void {
  server.registerResource(
    "Skill",
    new ResourceTemplate("skill://{skillName}", {
      list: async () => {
        // Dynamically return current skills
        const resources: Array<{ uri: string; name: string; mimeType: string; description?: string }> = [];

        for (const [name, skill] of skillState.skillMap) {
          resources.push({
            uri: `skill://${encodeURIComponent(name)}`,
            name,
            mimeType: "text/markdown",
            description: skill.description,
          });
        }

        return { resources };
      },
      complete: {
        skillName: (value: string) => {
          const names = Array.from(skillState.skillMap.keys());
          return names.filter((name) => name.toLowerCase().startsWith(value.toLowerCase()));
        },
      },
    }),
    {
      mimeType: "text/markdown",
      description: "SKILL.md content for a skill",
    },
    async (resourceUri) => {
      // Extract skill name from URI
      const uriStr = resourceUri.toString();
      const match = uriStr.match(/^skill:\/\/([^/]+)$/);

      if (!match) {
        throw new Error(`Invalid skill URI: ${uriStr}`);
      }

      const skillName = decodeURIComponent(match[1]);
      const skill = skillState.skillMap.get(skillName);

      if (!skill) {
        const available = Array.from(skillState.skillMap.keys()).join(", ");
        throw new Error(`Skill "${skillName}" not found. Available: ${available || "none"}`);
      }

      try {
        const content = loadSkillContent(skill.path);
        return {
          contents: [
            {
              uri: uriStr,
              mimeType: "text/markdown",
              text: content,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load skill "${skillName}": ${message}`);
      }
    }
  );
}

/**
 * Register the resource template for accessing files within skills.
 *
 * URI Pattern: skill://{skillName}/{filePath}
 */
function registerSkillFileTemplate(
  server: McpServer,
  skillState: SkillState
): void {
  server.registerResource(
    "Skill File",
    new ResourceTemplate("skill://{skillName}/{+filePath}", {
      list: async () => {
        // Return all listable skill files (dynamic based on current skillMap)
        const resources: Array<{ uri: string; name: string; mimeType: string }> = [];

        for (const [name, skill] of skillState.skillMap) {
          const skillDir = path.dirname(skill.path);
          const files = listSkillFiles(skillDir);

          for (const file of files) {
            const uri = `skill://${encodeURIComponent(name)}/${file}`;
            resources.push({
              uri,
              name: `${name}/${file}`,
              mimeType: getMimeType(file),
            });
          }
        }

        return { resources };
      },
      complete: {
        skillName: (value: string) => {
          const names = Array.from(skillState.skillMap.keys());
          return names.filter((name) => name.toLowerCase().startsWith(value.toLowerCase()));
        },
      },
    }),
    {
      mimeType: "text/plain",
      description: "Files within a skill directory (scripts, snippets, assets, etc.)",
    },
    async (resourceUri, variables) => {
      // Extract skill name and file path from URI
      const uriStr = resourceUri.toString();
      const match = uriStr.match(/^skill:\/\/([^/]+)\/(.+)$/);

      if (!match) {
        throw new Error(`Invalid skill file URI: ${uriStr}`);
      }

      const skillName = decodeURIComponent(match[1]);
      const filePath = match[2];

      const skill = skillState.skillMap.get(skillName);
      if (!skill) {
        const available = Array.from(skillState.skillMap.keys()).join(", ");
        throw new Error(`Skill "${skillName}" not found. Available: ${available || "none"}`);
      }

      const skillDir = path.dirname(skill.path);
      const fullPath = path.resolve(skillDir, filePath);

      // Security: Validate path is within skill directory
      if (!isPathWithinBase(fullPath, skillDir)) {
        throw new Error(`Path "${filePath}" is outside the skill directory`);
      }

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        const files = listSkillFiles(skillDir).slice(0, 10);
        throw new Error(
          `File "${filePath}" not found in skill "${skillName}". ` +
            `Available: ${files.join(", ")}${files.length >= 10 ? "..." : ""}`
        );
      }

      const stat = fs.statSync(fullPath);

      // Reject symlinks
      if (stat.isSymbolicLink()) {
        throw new Error(`Cannot read symlink "${filePath}"`);
      }

      // Reject directories
      if (stat.isDirectory()) {
        const files = listSkillFiles(skillDir, filePath);
        throw new Error(`"${filePath}" is a directory. Files within: ${files.join(", ")}`);
      }

      // Check file size
      if (stat.size > MAX_FILE_SIZE) {
        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
        throw new Error(`File too large (${sizeMB}MB). Maximum: 10MB`);
      }

      // Read and return content
      const content = fs.readFileSync(fullPath, "utf-8");
      const mimeType = getMimeType(fullPath);

      return {
        contents: [
          {
            uri: uriStr,
            mimeType,
            text: content,
          },
        ],
      };
    }
  );
}
