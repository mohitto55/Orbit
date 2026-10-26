/** CLI 모델 ID·별칭만 받는다. 줄바꿈이나 셸/슬래시 명령을 모델로 실행하지 않는다. */
export function modelProblem(model: string): string | undefined {
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]{0,255}$/.test(model)) return '모델에는 공백 없는 Model ID 또는 별칭을 입력하세요'
}
