export const SKILL_LOCATIONS = ['claude', 'codex', 'agents'] as const
export type SkillLocation = (typeof SKILL_LOCATIONS)[number]

export const SKILL_LOCATION_LABELS: Record<SkillLocation, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  agents: '공용'
}
