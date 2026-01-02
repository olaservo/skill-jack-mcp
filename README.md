# Skill Jack MCP

An MCP server that jacks [Agent Skills](https://agentskills.dev) directly into your LLM's brain.

## Features

- **Dynamic Skill Discovery** - Discovers skills from configured directory at startup, with additional discovery from MCP Roots after initialization
- **Server Instructions** - Injects skill metadata into the client's system prompt (for clients supporting instructions)
- **Skill Tool** - Load full skill content on demand (progressive disclosure)
- **MCP Resources** - Access skills via `skill://` URIs with batch collection support (for clients supporting resources)
- **Resource Subscriptions** - Real-time file watching with `notifications/resources/updated`
- **Live Updates** - Re-discovers skills when workspace roots change (updates tools, but not system prompt)

## Installation

```bash
npm install @olaservo/skill-jack-mcp
```

Or run directly with npx:

```bash
npx @olaservo/skill-jack-mcp
```

### From Source

```bash
git clone https://github.com/olaservo/skill-jack-mcp.git
cd skill-jack-mcp
npm install
npm run build
```

## Usage

### With Skills Directory (Recommended)

Configure a skills directory to ensure skills appear in the system prompt:

```bash
# Pass skills directory as argument
skill-jack-mcp /path/to/skills

# Or use environment variable
SKILLS_DIR=/path/to/skills skill-jack-mcp
```

The server scans the directory and its `.claude/skills/` and `skills/` subdirectories.

**Windows note**: Use forward slashes in paths when using with MCP Inspector:
```bash
skill-jack-mcp "C:/Users/you/skills"
```

### With MCP Roots (Additional)

If your [MCP client supports Roots](https://modelcontextprotocol.io/clients), skills are also discovered from workspace roots after initialization. These are available via tools but not in the system prompt (see [timing notes](#important-roots-vs-instructions-timing)).

```bash
# Run without arguments to use only roots (no system prompt skills)
skill-jack-mcp

# Or combine with a skills directory for both
skill-jack-mcp /path/to/skills
```

## How It Works

The server implements the Agent Skills progressive disclosure pattern with MCP Roots support:

1. **At startup**: Discovers skills from configured skills directory
2. **On connection**: Server instructions (with skill metadata) are sent in the initialize response
3. **After initialization**: Server requests workspace roots from client and updates available skills
4. **On tool call**: Agent calls `skill` tool to load full SKILL.md content
5. **Live updates**: Re-discovers when client's workspace roots change

```
┌─────────────────────────────────────────────────────────┐
│ Server starts                                            │
│   • Discovers skills from configured directory           │
│   • Generates initial instructions with skill metadata   │
│   ↓                                                      │
│ MCP Client connects (initialize request/response)        │
│   • Server instructions included in response             │
│   ↓                                                      │
│ Client sends initialized notification                    │
│   ↓                                                      │
│ Server requests roots from client                        │
│   • Scans .claude/skills/ and skills/ in each root      │
│   • Updates skill tools (but cannot update instructions) │
│   ↓                                                      │
│ LLM sees skill metadata in system prompt                 │
│ LLM calls "skill" tool with skill name                   │
│   ↓                                                      │
│ (Workspace changes → roots/list_changed → re-discover)   │
└─────────────────────────────────────────────────────────┘
```

### Important: Roots vs Instructions Timing

Per the [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), server `instructions` are sent in the initialize response, **before** the client sends the `initialized` notification. Roots can only be requested **after** initialization completes.

This means:
- **Skills from configured directory**: Appear in server instructions (system prompt) ✓
- **Skills from MCP Roots**: Only available via tools and resources after initialization

**Recommendation**: Always provide a skills directory argument if you want skills to appear in the LLM's system prompt. Roots are useful for dynamic workspace-specific skills that can be accessed via tools.

## Tools

### `skill`

Load and activate an Agent Skill by name. Returns the full SKILL.md content.

**Input:**
```json
{
  "name": "skill-name"
}
```

**Output:** Full SKILL.md content including frontmatter and instructions.

### `skill-resource`

Read files within a skill's directory (`scripts/`, `references/`, `assets/`, `snippets/`, etc.).

This follows the Agent Skills spec's progressive disclosure pattern - resources are loaded only when needed.

**Input:**
```json
{
  "skill": "mcp-server-ts",
  "path": "snippets/tools/echo.ts"
}
```

**Output:** File content.

**List available files** (pass empty path):
```json
{
  "skill": "mcp-server-ts",
  "path": ""
}
```

**Security:** Path traversal is prevented - only files within the skill directory can be accessed.

## Resources

Skills are also accessible via MCP [Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#resources) using `skill://` URIs.

### URI Patterns

| URI | Returns |
|-----|---------|
| `skill://` | All SKILL.md contents (collection) |
| `skill://{name}` | Single skill's SKILL.md content |
| `skill://{name}/` | All files in skill directory (collection) |
| `skill://{name}/{path}` | Specific file within skill |

### Resource Subscriptions

Clients can subscribe to resources for real-time updates when files change.

**Capability:** `resources: { subscribe: true, listChanged: true }`

**Subscribe to a resource:**
```
→ resources/subscribe { uri: "skill://mcp-server-ts" }
← {} (success)
```

**Receive notifications when files change:**
```
← notifications/resources/updated { uri: "skill://mcp-server-ts" }
```

**Unsubscribe:**
```
→ resources/unsubscribe { uri: "skill://mcp-server-ts" }
← {} (success)
```

**How it works:**
1. Client subscribes to a `skill://` URI
2. Server resolves URI to file path(s) and starts watching with chokidar
3. When files change, server debounces (100ms) and sends notification
4. Client can re-read the resource to get updated content

**URI to file path resolution:**
- `skill://` → watches all skill directories
- `skill://{name}` → watches that skill's SKILL.md
- `skill://{name}/{path}` → watches specific file

## Security

**Skills are treated as trusted content.** This server reads and serves skill files directly to clients without sanitization. Only configure skills directories containing content you trust.

Protections in place:
- Path traversal prevention (symlink-aware)
- File size limits (10MB max)
- Directory depth limits
- Skill content is confined to configured directories

Not protected against:
- Malicious content within trusted skill directories
- Prompt injection via skill instructions (skills can influence LLM behavior by design)

## Server Instructions Format

The server generates [instructions](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/) that include a usage preamble and skill metadata:

```markdown
# Skills

When a user's task matches a skill description below: 1) activate it, 2) follow its instructions completely.

<available_skills>
<skill>
<name>mcp-server-ts</name>
<description>Build TypeScript MCP servers with composable code snippets...</description>
<location>C:/path/to/mcp-server-ts/SKILL.md</location>
</skill>
</available_skills>
```

These are loaded into the model's system prompt by [clients](https://modelcontextprotocol.io/clients) that support instructions.

## Skill Discovery

### From Configured Directory (at startup)

Skills are discovered synchronously at startup from the configured directory. The server checks:
- The directory itself for skill subdirectories
- `.claude/skills/` subdirectory
- `skills/` subdirectory

These skills are included in server instructions (system prompt).

### From MCP Roots (after initialization)

When the client supports MCP [Roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots), the server also scans each workspace root for:
- `{root}/.claude/skills/`
- `{root}/skills/`

These skills are available via tools and resources, but not in the system prompt (see [Roots vs Instructions Timing](#important-roots-vs-instructions-timing)).

### Naming Conflicts

If the same skill name exists in multiple roots, it's prefixed with the root name (e.g., `project-a:commit`).

## Testing

```bash
# Build first
npm run build

# Test with MCP Inspector
npx @modelcontextprotocol/inspector@latest node dist/index.js /path/to/skills
```

## Related

- [Agent Skills Specification](https://agentskills.dev)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Example MCP Clients](https://modelcontextprotocol.io/clients)
