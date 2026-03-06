/**
 * Agent registry — loads agent definitions from markdown files.
 *
 * Agent definitions follow the OpenClaw pattern:
 * - YAML frontmatter with metadata
 * - Markdown body as the system prompt
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import matter from 'gray-matter';
import type { AgentDefinition, AgentRole } from './types.js';
import { coreValuesPrompt, type ForgeSettings } from '../config/index.js';

const AGENTS_DIR = 'agents';

interface AgentFrontmatter {
  name: string;
  role: AgentRole;
  description: string;
  tools: string;
}

/**
 * Load all agent definitions from the agents/ directory.
 */
export function loadAgents(settings: ForgeSettings): Map<AgentRole, AgentDefinition> {
  const agentsPath = resolve(settings.workspaceRoot, AGENTS_DIR);
  const files = readdirSync(agentsPath).filter((f) => f.endsWith('.md'));
  const agents = new Map<AgentRole, AgentDefinition>();

  const modelMap: Record<AgentRole, string> = {
    'architect': settings.models.architect,
    'planner': settings.models.planner,
    'test-engineer': settings.models.testEngineer,
    'developer': settings.models.developer,
    'pr-creator': settings.models.prCreator,
    'reviewer': settings.models.reviewer,
    'pr-reviewer': settings.models.prReviewer ?? settings.models.reviewer,
    'researcher': settings.models.researcher,
    'reflector': settings.models.reflector ?? settings.models.architect,
  };

  for (const file of files) {
    const raw = readFileSync(join(agentsPath, file), 'utf-8');
    const { data, content } = matter(raw);
    const meta = data as AgentFrontmatter;

    // Inject core values into every agent's system prompt
    const systemPrompt = [
      content.trim(),
      '',
      '---',
      '',
      coreValuesPrompt(),
    ].join('\n');

    const tools = meta.tools
      ? meta.tools.split(',').map((t) => t.trim())
      : ['Read', 'Write', 'Bash', 'Glob', 'Grep', 'TodoRead', 'TodoWrite'];

    agents.set(meta.role, {
      role: meta.role,
      name: meta.name,
      description: meta.description,
      model: modelMap[meta.role] ?? settings.models.developer,
      allowedTools: tools,
      systemPrompt,
    });
  }

  return agents;
}
