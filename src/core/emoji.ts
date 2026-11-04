/** 피부색·국기·가족처럼 여러 코드 포인트로 된 이모지도 한 아이콘으로 보존한다. */
export function normalizeEmoji(value?: string): string | undefined {
  const text = value?.trim()
  if (!text) return undefined
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
  if (segments.length !== 1 || !/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(text)) {
    throw new Error('이모지 한 개를 선택하거나 입력해 주세요')
  }
  return text
}
