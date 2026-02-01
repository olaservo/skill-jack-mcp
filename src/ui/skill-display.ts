/**
 * Skill Display MCP App - Vanilla JS implementation
 */
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";

// Types
interface SkillDisplayInfo {
  name: string;
  description: string;
  path: string;
  assistantInvocable: boolean;
  userInvocable: boolean;
  isAssistantOverridden: boolean;
  isUserOverridden: boolean;
}

interface SkillDisplayState {
  skills: SkillDisplayInfo[];
  totalCount: number;
  success?: boolean;
  error?: string;
}

// State
let skills: SkillDisplayInfo[] = [];
let searchQuery = "";
let app: App | null = null;

// DOM Elements
const skillList = document.getElementById("skill-list")!;
const stats = document.getElementById("stats")!;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const toast = document.getElementById("toast")!;

// Handle host context changes
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleHostContextChanged(ctx: any) {
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
  // Handle safe area insets for mobile/notched devices
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    document.body.style.paddingTop = `${top + 16}px`;
    document.body.style.paddingRight = `${right + 16}px`;
    document.body.style.paddingBottom = `${bottom + 16}px`;
    document.body.style.paddingLeft = `${left + 16}px`;
  }
}

// Update state from tool result
function updateState(data: SkillDisplayState) {
  if (data.skills) {
    skills = data.skills;
  }
  render();
}

// Get filtered skills based on search query
function getFilteredSkills(): SkillDisplayInfo[] {
  if (!searchQuery) {
    return skills;
  }
  const query = searchQuery.toLowerCase();
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query)
  );
}

// Render the UI
function render() {
  renderStats();
  renderSkills();
}

function renderStats() {
  const filtered = getFilteredSkills();
  if (searchQuery) {
    stats.textContent = `${filtered.length} of ${skills.length} skills`;
  } else {
    stats.textContent = `${skills.length} skill${skills.length !== 1 ? "s" : ""} available`;
  }
}

function renderSkills() {
  const filtered = getFilteredSkills();

  if (skills.length === 0) {
    skillList.innerHTML = `
      <div class="empty-state">
        <p>No skills available.</p>
        <p>Configure skill directories using the skill-config tool.</p>
      </div>
    `;
    return;
  }

  if (filtered.length === 0) {
    skillList.innerHTML = `
      <div class="empty-state">
        <p>No skills match your search.</p>
      </div>
    `;
    return;
  }

  skillList.innerHTML = filtered
    .map((skill) => {
      const isCustomized = skill.isAssistantOverridden || skill.isUserOverridden;
      return `
      <div class="skill-card" data-skill="${escapeHtml(skill.name)}">
        <div class="skill-header">
          <span class="skill-name">${escapeHtml(skill.name)}</span>
          ${isCustomized ? '<span class="customized-badge">Customized</span>' : ""}
        </div>
        <p class="skill-description">${escapeHtml(skill.description)}</p>
        <div class="skill-path">${escapeHtml(skill.path)}</div>
        <div class="skill-controls">
          <div class="toggle-group">
            <span class="toggle-label ${skill.isAssistantOverridden ? "overridden" : ""}">Assistant</span>
            <div
              class="toggle-switch ${skill.assistantInvocable ? "active" : ""}"
              data-skill="${escapeHtml(skill.name)}"
              data-setting="assistant"
              data-value="${skill.assistantInvocable}"
              title="${skill.assistantInvocable ? "Model can auto-invoke this skill" : "Model cannot auto-invoke this skill"}"
            ></div>
          </div>
          <div class="toggle-group">
            <span class="toggle-label ${skill.isUserOverridden ? "overridden" : ""}">User</span>
            <div
              class="toggle-switch ${skill.userInvocable ? "active" : ""}"
              data-skill="${escapeHtml(skill.name)}"
              data-setting="user"
              data-value="${skill.userInvocable}"
              title="${skill.userInvocable ? "Appears in prompts menu" : "Hidden from prompts menu"}"
            ></div>
          </div>
          <button
            class="reset-btn"
            data-skill="${escapeHtml(skill.name)}"
            ${!isCustomized ? "disabled" : ""}
            title="Reset to frontmatter defaults"
          >Reset</button>
        </div>
      </div>
    `;
    })
    .join("");

  // Add click handlers for toggle switches
  skillList.querySelectorAll(".toggle-switch").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const skillName = (toggle as HTMLElement).dataset.skill;
      const setting = (toggle as HTMLElement).dataset.setting as "assistant" | "user";
      const currentValue = (toggle as HTMLElement).dataset.value === "true";
      if (skillName && setting) {
        updateInvocation(skillName, setting, !currentValue);
      }
    });
  });

  // Add click handlers for reset buttons
  skillList.querySelectorAll(".reset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const skillName = (btn as HTMLButtonElement).dataset.skill;
      if (skillName) {
        resetOverride(skillName);
      }
    });
  });
}

// Update invocation setting
async function updateInvocation(
  skillName: string,
  setting: "assistant" | "user",
  value: boolean
) {
  try {
    const result = await app!.callServerTool({
      name: "skill-display-update-invocation",
      arguments: { skillName, setting, value },
    });

    console.log("Update result:", result);

    const structured = result.structuredContent as unknown as SkillDisplayState;
    if (structured?.success) {
      updateState(structured);
      showToast(`${skillName}: ${setting} = ${value ? "on" : "off"}`, "success");
    } else {
      showToast(structured?.error || "Failed to update", "error");
    }
  } catch (error) {
    console.error("Update invocation error:", error);
    showToast((error as Error).message || "Failed to update", "error");
  }
}

// Reset override
async function resetOverride(skillName: string) {
  try {
    const result = await app!.callServerTool({
      name: "skill-display-reset-override",
      arguments: { skillName },
    });

    console.log("Reset result:", result);

    const structured = result.structuredContent as unknown as SkillDisplayState;
    if (structured?.success) {
      updateState(structured);
      showToast(`${skillName} reset to defaults`, "success");
    } else {
      showToast(structured?.error || "Failed to reset", "error");
    }
  } catch (error) {
    console.error("Reset override error:", error);
    showToast((error as Error).message || "Failed to reset", "error");
  }
}

// Toast
function showToast(message: string, type: "success" | "error" = "success") {
  toast.textContent = message;
  toast.className = `toast ${type} visible`;
  setTimeout(() => {
    toast.classList.remove("visible");
  }, 3000);
}

// Utilities
function escapeHtml(str: string): string {
  if (!str) return "";
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c
  );
}

// Set up event listeners
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value.trim();
  render();
});

// 1. Create app instance
app = new App({ name: "Skill Display", version: "1.0.0" });

// 2. Register handlers BEFORE connecting
app.onteardown = async () => {
  console.info("App is being torn down");
  return {};
};

app.ontoolinput = (params) => {
  console.info("Received tool input:", params);
};

app.ontoolresult = (result) => {
  console.info("Received tool result:", result);
  if (result.structuredContent) {
    updateState(result.structuredContent as SkillDisplayState);
  }
};

app.ontoolcancelled = (params) => {
  console.info("Tool call cancelled:", params.reason);
};

app.onerror = console.error;

app.onhostcontextchanged = handleHostContextChanged;

// 3. Connect to host
app.connect().then(() => {
  console.info("Connected to host");

  // Apply initial host context
  const ctx = app!.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
