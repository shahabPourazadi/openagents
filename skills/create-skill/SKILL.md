---
name: Create skill
description: Create effective OpenAgents Agent Skills (SKILL.md playbooks). Use when the user wants to author a new skill, improve skill structure, or asks how to write SKILL.md files.
icon: pencil-ruler
---

# Creating Skills in OpenAgents

This skill guides you through creating effective Agent Skills for OpenAgents. Skills are markdown playbooks (`SKILL.md`) the deep agent loads on demand — not callable tools.

## Before You Begin: Gather Requirements

Before creating a skill, gather essential information from the user about:

1. **Purpose and scope**: What specific task or workflow should this skill help with?
2. **Target location**: Library skill (sidebar Skills / user skills) or agent-scoped under `agents/<slug>/skills/`?
3. **Trigger scenarios**: When should the agent load this skill?
4. **Key domain knowledge**: What specialized information does the agent need that it wouldn't already know?
5. **Output format preferences**: Are there specific templates, formats, or styles required?
6. **Existing patterns**: Are there existing examples or conventions to follow?

### Verbatim text from the user

If the user includes exact wording to use in the skill, respect it and use it **verbatim** in `SKILL.md` (same words, same order). Do not paraphrase, soften, or expand their copy, and do not add unrequested headings or commentary around it.

### Inferring from Context

If you have previous conversation context, infer the skill from what was discussed. You can create skills based on workflows, patterns, or domain knowledge that emerged in the conversation.

## Skill File Structure

### Directory Layout

```
skills/<skill-slug>/
└── SKILL.md              # Required - main instructions
```

Agent-scoped skills live under:

```
agents/<agent-slug>/skills/<skill-slug>/SKILL.md
```

User library skills are created via the sidebar **Skills → +** wizard (stored in the DB; includes name, description, **icon**, and SKILL.md body) or registered through Agent Builder / chat tools.

Agents can also mark library skills as **predefined** (wizard checkboxes or Agent Builder `predefined_skills` in `agent.yaml`) so the skill body is rooted in that agent’s system prompt. All agents can still load any library skill on demand via `/` in chat. See `docs/skills.md`.

### SKILL.md Structure

Every skill requires a `SKILL.md` file with YAML frontmatter and markdown body:

```markdown
---
name: your-skill-name
description: Brief description of what this skill does and when to use it
icon: pencil-ruler
---

# Your Skill Name

## Instructions
Clear, step-by-step guidance for the agent.

## Examples
Concrete examples of using this skill.
```

### Required Metadata Fields

| Field | Requirements | Purpose |
|-------|--------------|---------|
| `name` | Max 64 chars, lowercase letters/numbers/hyphens only | Unique identifier for the skill |
| `description` | Max 1024 chars, non-empty | Helps the agent decide when to load it |
| `icon` | Optional Lucide id (same catalog as agents; default `pencil-ruler`) | Sidebar / mention UI |

## Writing Effective Descriptions

The description is **critical** for skill discovery. The agent uses it to decide when to apply your skill.

### Description Best Practices

1. **Write in third person** (the description is injected into catalogs):
   - Good: "Processes Excel files and generates reports"
   - Avoid: "I can help you process Excel files"

2. **Be specific and include trigger terms**:
   - Good: "Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction."
   - Vague: "Helps with documents"

3. **Include both WHAT and WHEN**:
   - WHAT: What the skill does (specific capabilities)
   - WHEN: When the agent should use it (trigger scenarios)

## Core Authoring Principles

### 1. Concise is Key

The context window is shared with conversation history, other skills, and requests. Every token competes for space.

**Default assumption**: The agent is already very smart. Only add context it doesn't already have.

Challenge each piece of information:
- "Does the agent really need this explanation?"
- "Can I assume the agent knows this?"
- "Does this paragraph justify its token cost?"

### 2. Keep SKILL.md Under 500 Lines

For optimal performance, the main SKILL.md file should be concise. Use progressive disclosure for detailed content in linked files only when needed.

### 3. Progressive Disclosure

Put essential information in SKILL.md; detailed reference material in separate files the agent reads only when needed. Keep references one level deep.

### 4. Set Appropriate Degrees of Freedom

| Freedom Level | When to Use | Example |
|---------------|-------------|---------|
| **High** (text instructions) | Multiple valid approaches, context-dependent | Code review guidelines |
| **Medium** (pseudocode/templates) | Preferred pattern with acceptable variation | Report generation |
| **Low** (specific scripts/commands) | Fragile operations, consistency critical | Exact tool call sequences |

## Common Patterns

### Template Pattern

Provide output format templates the agent should fill.

### Examples Pattern

For skills where output quality depends on seeing examples, include concrete input → output pairs.

### Workflow Pattern

Break complex operations into clear steps with checklists.

### Feedback Loop Pattern

For quality-critical tasks, validate after each step and only proceed when checks pass.

## Anti-Patterns to Avoid

1. **Too many options** — pick a default with an escape hatch
2. **Time-sensitive information** — prefer "current method" vs "old patterns" sections
3. **Inconsistent terminology** — choose one term and use it throughout
4. **Vague skill names** — prefer `processing-pdfs` over `helper` / `utils`
5. **Inventing tools** — only reference tools OpenAgents actually has (`suggest_edit`, filesystem, execute/sandbox, MCP, etc.)

## Skill Creation Workflow

### Phase 1: Discovery

Gather purpose, storage location, triggers, constraints, and examples.

### Phase 2: Design

1. Draft the skill slug (lowercase, hyphens, max 64 chars)
2. Write a specific, third-person description
3. Outline the main sections
4. Identify if supporting files are needed

### Phase 3: Implementation

1. Prefer the sidebar **New skill** wizard for library skills (name, description, icon, SKILL.md body)
2. Or write `skills/<slug>/SKILL.md` / `agents/<agent>/skills/<slug>/SKILL.md` with filesystem tools
3. Validate: non-empty name, description, and body; safe slug (`a-z0-9` + hyphens); optional `icon` frontmatter

### Phase 4: Verification

- [ ] Description is specific and includes key terms
- [ ] Description includes both WHAT and WHEN
- [ ] Written in third person
- [ ] SKILL.md body is under 500 lines
- [ ] Consistent terminology throughout
- [ ] Examples are concrete, not abstract
- [ ] References real OpenAgents tools only

## Registering / Saving

- **Library skill (sidebar)**: create or update via the Skills wizard / `POST|PATCH /api/skills` (supports `icon`)
- **Predefined on an agent**: select in New/Edit agent wizard, or set `predefined_skills` in `agent.yaml` then `register_agent_from_workspace` (Agent Builder)
- **Agent-scoped skill**: write under the agent folder and re-register the agent, or PATCH the user agent `skills` array
- Never claim a skill was saved without calling the appropriate tool or confirming the UI save succeeded
