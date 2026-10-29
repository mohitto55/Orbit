/** CLI 모델 ID·별칭만 받는다. 줄바꿈이나 셸/슬래시 명령을 모델로 실행하지 않는다. */
export function modelProblem(model: string): string | undefined {
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]{0,255}$/.test(model)) return '모델에는 공백 없는 Model ID 또는 별칭을 입력하세요'
}

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type AgentEffort = (typeof EFFORTS)[number]
export interface AgentOptions { model?: string; effort?: AgentEffort }
export const effortChoices = (kind: 'claude' | 'codex'): readonly AgentEffort[] => kind === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : EFFORTS
export const isEffort = (value: unknown): value is AgentEffort => typeof value === 'string' && EFFORTS.some((effort) => effort === value)
export function effortProblem(kind: 'claude' | 'codex', effort?: string): string | undefined {
  if (effort && !effortChoices(kind).some((value) => value === effort)) return `${kind}: 지원하지 않는 Effort입니다`
}
