# Skill Activation Findings

Investigation into why skills work automatically in some modes but not others.

## Test Results

| Mode | Skills Discovered | Auto-Activation | Result |
|------|-------------------|-----------------|--------|
| **MCP** | Via tool description | Yes | PASS |
| **CLI Native** | Via `.claude/skills/` | Yes | PASS |
| **SDK Native** | Via `settingSources` | No | FAIL |

## Root Cause

The [Agent Skills specification](https://agentskills.io/specification) states:

> "Include skill metadata in the system prompt so the model knows what skills are available."

The recommended format:
```xml
<available_skills>
  <skill>
    <name>pdf-processing</name>
    <description>Extracts text and tables from PDF files...</description>
    <location>/path/to/skills/pdf-processing/SKILL.md</location>
  </skill>
</available_skills>
```

### How Each Mode Handles This

**MCP Mode**: Skills are listed in the `skill` tool description with names and descriptions. The agent sees this in the tool definition and knows when to use them.

**CLI Native Mode**: Claude Code CLI automatically injects skill metadata into the system prompt. When we tested with `claude -p`, the agent immediately recognized the greeting request matched the "greeting" skill description and called the Skill tool.

**SDK Native Mode**: The `settingSources: ['project']` configuration discovers skills and makes the `Skill` tool available, but does NOT appear to inject skill metadata into the system prompt. The agent knows the Skill tool exists but doesn't know what skills are available or when to use them.

## Evidence

### CLI Native Mode Success
```bash
claude -p --output-format stream-json --verbose --dangerously-skip-permissions -- "Hello! Can you greet me?"
```

Output showed:
1. Init message included `"skills":["code-style","greeting","template-generator"]`
2. Agent immediately called `Skill` tool with `{"skill":"greeting"}`
3. Response included `SKILLJACK_GREETING_SUCCESS`

### SDK Native Mode Failure
```typescript
const options = {
  cwd: process.cwd(),
  settingSources: ['project' as const],
  allowedTools: ["Bash", "Read", "Write", "Skill"],
  permissionMode: "default" as const,
  model: modelId
};
```

The agent responded to "Hello! Can you greet me?" with a generic greeting, never calling the Skill tool.

## Solution Options

### Option 1: Explicit System Prompt (Workaround)

Add skill metadata to the system prompt manually when using the SDK:

```typescript
const skillsXml = `
<available_skills>
  <skill>
    <name>greeting</name>
    <description>Respond to greetings with a specific format</description>
  </skill>
</available_skills>

When a user request matches an available skill's description, use the Skill tool to load and follow those instructions.
`;

const options = {
  systemPrompt: skillsXml,
  settingSources: ['project' as const],
  allowedTools: ["Skill", ...],
  // ...
};
```

### Option 2: Use MCP Mode

Use skilljack or similar MCP server to deliver skills. The tool description includes skill metadata, so no system prompt modification needed.

### Option 3: SDK Enhancement (Future)

The Agent SDK could be enhanced to automatically inject discovered skill metadata into the system prompt, similar to how Claude Code CLI does it.

## Recommendation

For now, when using the Agent SDK's native skill support:
1. Either add skill metadata to the system prompt explicitly
2. Or use MCP-based skill delivery (skilljack)

The MCP approach has advantages:
- No system prompt modification needed
- Dynamic updates via `tools/listChanged`
- Progressive disclosure (full content loaded on demand)

## Related Documentation

- [Agent Skills Specification](https://agentskills.io/specification)
- [Integrate Skills Guide](https://agentskills.io/integrate-skills)
- [Claude Code Skills Docs](https://docs.anthropic.com/en/docs/claude-code/skills)

## TODO

- [ ] Verify if there's an SDK option to auto-inject skill metadata
- [ ] Test with explicit system prompt to confirm the fix works
- [ ] Consider adding a helper function to generate skills XML from discovered skills
