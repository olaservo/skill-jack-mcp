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
  // Source information
  sourceType: "local" | "github";
  sourceDisplayName: string;
  sourceOwner?: string;
  sourceRepo?: string;
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
      // Build source badge based on type
      const sourceBadge = skill.sourceType === "github"
        ? `<span class="source-badge github" title="From GitHub: ${escapeHtml(skill.sourceDisplayName)}">
             <svg class="source-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
               <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
             </svg>
             ${escapeHtml(skill.sourceDisplayName)}
           </span>`
        : `<span class="source-badge local" title="Local skill directory">
             <svg class="source-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
               <path fill="currentColor" d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/>
             </svg>
             Local
           </span>`;
      return `
      <div class="skill-card" data-skill="${escapeHtml(skill.name)}">
        <div class="skill-header">
          <span class="skill-name">${escapeHtml(skill.name)}</span>
          <div class="skill-badges">
            ${sourceBadge}
            ${isCustomized ? '<span class="customized-badge">Customized</span>' : ""}
          </div>
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
