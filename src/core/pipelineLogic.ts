/** 그래프의 비교·논리 연산. 문자열을 코드로 실행하지 않고 지정된 연산만 평가한다. */
export const COMPARE_OPS = { eq: '같다 (==)', ne: '다르다 (!=)', gt: '크다 (>)', gte: '크거나 같다 (>=)', lt: '작다 (<)', lte: '작거나 같다 (<=)' } as const
export type CompareOp = keyof typeof COMPARE_OPS
export type CompareType = 'single' | 'number' | 'boolean'
type Operation = CompareOp | 'and' | 'or' | 'not' | 'number' | 'boolean'
interface Calculation { op: Operation; type: CompareType; inputs: string[] }
const TOKEN = /\u0000계산:([^\u0000]*)\u0000/g
const pending = (value: string) => /\u0000(?:출력|JSON|계산|입력):/.test(value) || /\{\{[^{}]+\}\}/.test(value) || /^\[반복 (항목|인덱스)\]$/.test(value)
const decode = (encoded: string) => JSON.parse(decodeURIComponent(encoded)) as Calculation

export function boolValue(value: string): boolean {
  if (value.trim() === 'true') return true
  if (value.trim() === 'false') return false
  throw new Error('Bool 값은 true 또는 false여야 합니다')
}

function numberValue(value: string): number {
  const number = Number(value)
  if (!value.trim() || !Number.isFinite(number)) throw new Error('유효한 숫자를 입력하거나 연결하세요')
  return number
}

export function calculate(op: Operation, type: CompareType, inputs: string[]): string {
  const expected = ['not', 'number', 'boolean'].includes(op) ? 1 : 2
  if (inputs.length !== expected) throw new Error('계산 입력 개수가 맞지 않습니다')
  if (!['eq', 'ne', 'and', 'or', 'not', 'number', 'boolean'].includes(op) && type !== 'number') throw new Error('크기 비교에는 숫자를 연결하세요')
  if (inputs.some(pending)) return `\u0000계산:${encodeURIComponent(JSON.stringify({ op, type, inputs }))}\u0000`
  if (op === 'boolean') return String(boolValue(inputs[0]))
  if (op === 'number') return String(numberValue(inputs[0]))
  if (op === 'not') return String(!boolValue(inputs[0]))
  if (op === 'and' || op === 'or') {
    const a = boolValue(inputs[0]), b = boolValue(inputs[1])
    return String(op === 'and' ? a && b : a || b)
  }
  const values = inputs.map((value) => type === 'number' ? numberValue(value) : type === 'boolean' ? boolValue(value) : value)
  const [a, b] = values
  switch (op) {
    case 'eq': return String(a === b)
    case 'ne': return String(a !== b)
    case 'gt': return String(a > b)
    case 'gte': return String(a >= b)
    case 'lt': return String(a < b)
    case 'lte': return String(a <= b)
    default: throw new Error('지원하지 않는 비교 연산입니다')
  }
}

export const calculationInputs = (text: string): string[] => [...text.matchAll(TOKEN)].flatMap((match) => decode(match[1]).inputs)
export function fillCalculations(text: string, resolve: (input: string) => string, preview = false): string {
  return text.replace(TOKEN, (_match, encoded: string) => {
    const { op, type, inputs } = decode(encoded)
    const values = inputs.map(resolve)
    if (preview && inputs.some(pending)) return `${op in COMPARE_OPS ? COMPARE_OPS[op as CompareOp] : op.toUpperCase()}(${values.join(', ')})`
    return calculate(op, type, values)
  })
}
