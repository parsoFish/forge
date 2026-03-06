/**
 * Core values encoded as structured data.
 * These drive agent behavior, prompt construction, and quality gates.
 */

export interface CoreValue {
  readonly name: string;
  readonly principle: string;
  readonly rules: readonly string[];
}

export const CORE_VALUES: readonly CoreValue[] = [
  {
    name: 'Quality Gatekeeper',
    principle: 'Zero tolerance for warnings. TDD by default. Strict formatting.',
    rules: [
      'Run linters and formatters before declaring work complete',
      'Write tests before implementation (TDD) unless technically impractical',
      'Zero lint warnings, zero type errors, zero deprecation notices',
      'Coverage must be meaningful — behavior, edge cases, failure modes',
    ],
  },
  {
    name: 'Pattern-Driven Architecture',
    principle: 'Use established patterns. Invest in good abstractions. Follow ecosystem conventions.',
    rules: [
      'Reach for proven patterns first: DDD, hexagonal, repository, strategy',
      'Interfaces and dependency injection serve separation of concerns',
      'Vet dependencies for maintenance health, security, API stability',
      'Follow language/framework conventions religiously — don\'t fight the tool',
    ],
  },
  {
    name: 'Bold & Clean Change Management',
    principle: 'Actively pay down tech debt. Willing to break things to improve them.',
    rules: [
      'Clean up messes near where you\'re working — no broken windows',
      'Large refactors are acceptable when they produce better architecture',
      'Track tech debt with rationale and remediation path',
      'Breaking changes are fine when communicated clearly with migration paths',
    ],
  },
  {
    name: 'Why-Focused Documentation',
    principle: 'Comments explain WHY. PRs explain decisions. READMEs are concise but thorough.',
    rules: [
      'Comments explain reasoning, not mechanics — the code shows WHAT',
      'PR descriptions explain why this approach was chosen over alternatives',
      'Every project gets a README; complex topics go in docs/',
      'ADRs for significant architectural decisions in docs/decisions/',
    ],
  },
  {
    name: 'High Agent Autonomy',
    principle: 'Agents decide most things. Escalate only for major arch shifts or ambiguity.',
    rules: [
      'Own implementation details, refactoring scope, and dependency choices',
      'Escalate: major architectural shifts, ambiguous requirements, cross-project breaks, security',
      'Pursue better approaches when found — document the reasoning',
      'Experiments stay off the main branch',
    ],
  },
] as const;

export const TESTING_STRATEGY = {
  unit: {
    purpose: 'Verify isolated logic and pure functions',
    scope: 'Single function/class',
    when: 'Always — every piece of logic gets unit tests',
  },
  integration: {
    purpose: 'Validate component boundaries and contracts',
    scope: 'Module interactions, API contracts, DB queries',
    when: 'When components interact across boundaries',
  },
  e2e: {
    purpose: 'Confirm critical user flows work end-to-end',
    scope: 'Full system paths',
    when: 'For critical user-facing flows',
  },
  explorative: {
    purpose: 'Fuzz/property-based testing for edge cases',
    scope: 'Domain-specific risk areas',
    when: 'When the domain warrants it — parsing, crypto, data transforms',
  },
} as const;

/**
 * Build the core values into a prompt fragment for agent injection.
 */
export function coreValuesPrompt(): string {
  const lines = ['## Core Engineering Values\n'];
  for (const value of CORE_VALUES) {
    lines.push(`### ${value.name}`);
    lines.push(`**Principle:** ${value.principle}\n`);
    for (const rule of value.rules) {
      lines.push(`- ${rule}`);
    }
    lines.push('');
  }

  lines.push('## Testing Strategy\n');
  for (const [layer, info] of Object.entries(TESTING_STRATEGY)) {
    lines.push(`- **${layer}**: ${info.purpose} (${info.scope}) — ${info.when}`);
  }

  return lines.join('\n');
}
