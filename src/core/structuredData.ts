/** 그래프의 출력 계약과 JSON 값. 터미널 표시 문자열을 JSON으로 추측하지 않는다. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export const FIELD_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'null'] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export interface OutputType { type: FieldType; description: string; fields?: OutputField[]; items?: OutputType }
export interface OutputField extends OutputType { name: string }
export const FIELD_TYPE_NAME: Record<FieldType, string> = {
  string: 'String', number: 'Number', boolean: 'Boolean', object: 'Object', array: 'Array', null: 'Null'
}
export interface OutputValueSchema {
  type?: FieldType
  description?: string
  properties?: Record<string, OutputValueSchema>
  required?: string[]
  additionalProperties?: false
  items?: OutputValueSchema
}
export interface OutputSchema extends OutputValueSchema {
  type: 'object'
  properties: Record<string, OutputValueSchema>
  required: string[]
  additionalProperties: false
}
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 저장된 필드 정의를 재귀적으로 읽는다. 기존에 Items·Properties가 없던 정의는 유지한다. */
export function readOutputFields(value: unknown): OutputField[] {
  if (!Array.isArray(value)) return []
  return value.filter(isObject).map((field) => ({ name: String(field.name ?? ''), ...readOutputType(field) }))
}
function readOutputType(value: Record<string, unknown>): OutputType {
  const type = FIELD_TYPES.includes(value.type as FieldType) ? value.type as FieldType : 'string'
  return { type, description: String(value.description ?? ''),
    ...(type === 'object' && Array.isArray(value.fields) ? { fields: readOutputFields(value.fields) } : {}),
    ...(type === 'array' && isObject(value.items) ? { items: readOutputType(value.items) } : {}) }
}

export function schemaFromFields(fields: OutputField[]): OutputSchema {
  if (!fields.length) throw new Error('출력 필드를 하나 이상 추가하세요')
  return objectSchema(fields)
}

function objectSchema(fields: OutputField[]): OutputSchema {
  const names = fields.map((f) => f.name.trim())
  if (names.some((name) => !name)) throw new Error('출력 필드 이름을 입력하세요')
  if (new Set(names).size !== names.length) throw new Error('출력 필드 이름은 겹칠 수 없습니다')
  if (fields.some((f) => !FIELD_TYPES.includes(f.type))) throw new Error('지원하지 않는 출력 필드 타입입니다')
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map((field, i) => [names[i], valueSchema(field)])),
    required: names,
    additionalProperties: false
  }
}

function valueSchema(value: OutputType): OutputValueSchema {
  if (!FIELD_TYPES.includes(value.type)) throw new Error('지원하지 않는 출력 필드 타입입니다')
  return { type: value.type, description: value.description,
    ...(value.type === 'object' && value.fields ? objectSchema(value.fields) : {}),
    ...(value.type === 'array' ? { items: value.items ? valueSchema(value.items) : {} } : {}) }
}

function fieldsFromSchema(value: Record<string, unknown>, path: string): OutputField[] {
  if (!isObject(value.properties) || value.additionalProperties !== false || !Array.isArray(value.required)) throw new Error(`${path}: Properties와 Required를 지정한 Object 구조가 필요합니다`)
  const names = Object.keys(value.properties), required = value.required
  if (required.length !== names.length || names.some((name) => !required.includes(name))) throw new Error(`${path}: 출력 구조의 필수 필드가 맞지 않습니다`)
  return Object.entries(value.properties).map(([name, field]) => ({ name, ...typeFromSchema(field, `${path}.${name}`) }))
}
function typeFromSchema(value: unknown, path: string): OutputType {
  if (!isObject(value) || !FIELD_TYPES.includes(value.type as FieldType)) throw new Error(`${path}: 지원하지 않는 출력 필드 타입입니다`)
  const result: OutputType = { type: value.type as FieldType, description: typeof value.description === 'string' ? value.description : '' }
  if (result.type === 'object' && (value.properties !== undefined || value.required !== undefined || value.additionalProperties !== undefined)) result.fields = fieldsFromSchema(value, path)
  if (result.type === 'array' && value.items !== undefined) {
    // 예전의 빈 Items({})는 내부 타입을 제한하지 않았다.
    if (!isObject(value.items) || Object.keys(value.items).length) result.items = typeFromSchema(value.items, `${path}[]`)
  }
  return result
}

/** 저장된 데이터나 함수에서 온 계약도 같은 제한된 형식으로 검사한다. */
export function readOutputSchema(text: string): OutputSchema {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('출력 구조가 올바른 JSON이 아닙니다') }
  if (!isObject(value) || value.type !== 'object' || !isObject(value.properties) || value.additionalProperties !== false || !Array.isArray(value.required)) throw new Error('출력 구조 노드의 Dictionary 형식을 연결하세요')
  return schemaFromFields(fieldsFromSchema(value, 'output'))
}

export function parseJson(text: string): JsonValue {
  const source = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
  try {
    return JSON.parse(source, (_key: string, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('숫자 범위를 넘었습니다')
      return value
    }) as JsonValue
  } catch { throw new Error('응답이 올바른 JSON이 아닙니다. JSON만 출력하도록 요청하세요') }
}
export function jsonType(value: JsonValue): FieldType {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value as Exclude<FieldType, 'null' | 'array'>
}
export const jsonText = (value: JsonValue) => typeof value === 'string' ? value : JSON.stringify(value, null, 2)

export function validateOutput(text: string, schemaText: string): JsonObject {
  const schema = readOutputSchema(schemaText)
  const value = parseJson(text)
  if (!isObject(value)) throw new Error('출력은 Dictionary (JSON 객체)여야 합니다')
  validateValue(value as JsonObject, schema, '')
  return value as JsonObject
}

function validateValue(value: JsonValue, schema: OutputValueSchema, path: string): void {
  if (!schema.type) return
  const actual = jsonType(value)
  if (actual !== schema.type) throw new Error(`출력 필드 "${path}": ${FIELD_TYPE_NAME[schema.type]}이 필요하지만 ${FIELD_TYPE_NAME[actual]}입니다`)
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateValue(item, schema.items!, `${path}[${index}]`))
  }
  if (schema.type === 'object' && isObject(value) && schema.properties) {
    const childPath = (key: string) => path ? `${path}.${key}` : key
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new Error(`출력 필드 "${childPath(key)}"가 없습니다`)
      validateValue(value[key] as JsonValue, schema.properties[key], childPath(key))
    }
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`정의하지 않은 출력 필드 "${childPath(key)}"가 있습니다`)
  }
}

export function structuredPrompt(prompt: string, schema: string): string {
  return `${prompt}\n\n[출력 형식]\n최종 응답은 아래 JSON Schema를 따르는 JSON 객체 하나로 작성하세요. 각 필드의 description에 적힌 작성 규칙을 따르세요. 코드 블록이나 JSON 밖의 설명은 쓰지 마세요.\n${schema}`
}

// 기존 출력 토큰과 함께 중첩되는 JSON 선택식을 보관한다. 실행 시에만 실제 값을 읽는다.
const JSON_TOKEN = /\u0000JSON:([^\u0000]*)\u0000/g
interface JsonSelection { input: string; path: string[]; object: boolean }
const decodeSelection = (encoded: string) => JSON.parse(decodeURIComponent(encoded)) as JsonSelection
export function selectionInputs(text: string): string[] {
  return [...text.matchAll(JSON_TOKEN)].map((match) => decodeSelection(match[1]).input)
}
export function selectJson(input: string, path: string[] = [], object = false): string {
  if (/\u0000(?:출력|JSON|계산):/.test(input)) return `\u0000JSON:${encodeURIComponent(JSON.stringify({ input, path, object }))}\u0000`
  let value = parseJson(input)
  for (const key of path) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) throw new Error(`배열에 ${key} 인덱스가 없습니다`)
      value = value[Number(key)]
    } else {
      if (!isObject(value) || !Object.hasOwn(value, key)) throw new Error(`Dictionary에 "${key}" 키가 없습니다`)
      value = value[key] as JsonValue
    }
  }
  if (object && !isObject(value)) throw new Error('Dictionary에는 JSON 객체를 연결하세요')
  // JSON 데이터 선은 문자열도 따옴표를 유지한다. 중첩 선택에서 타입을 잃지 않는다.
  return JSON.stringify(value, null, 2)
}
export function fillSelections(text: string, resolve: (input: string) => string, preview = false): string {
  return text.replace(JSON_TOKEN, (_match, encoded: string) => {
    const selection = decodeSelection(encoded)
    const input = resolve(selection.input)
    if (preview && /\u0000(?:출력|JSON|계산):/.test(selection.input)) return `${input}${selection.path.map((key) => `[${JSON.stringify(key)}]`).join('')}`
    return selectJson(input, selection.path, selection.object)
  })
}

/** JSON Pointer로 키 안의 점·슬래시·빈 문자열도 모호하지 않게 선택한다. */
export const toPointer = (path: string[]) => path.map((key) => '/' + key.replace(/~/g, '~0').replace(/\//g, '~1')).join('')
export function fromPointer(pointer: string): string[] {
  if (!pointer) return []
  if (!pointer.startsWith('/') || /~(?![01])/g.test(pointer)) throw new Error('필드 경로는 /result 또는 /items/0/value 형식으로 입력하세요')
  return pointer.slice(1).split('/').map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'))
}
