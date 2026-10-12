/**
 * 앱 로고(마크만). 원본 아이콘은 build/icon.svg (검정 바탕).
 * 궤도 링과 위성 하나. 글자색(currentColor)으로 그려서 밝은 테마에선 검정, 어두운 테마에선 하양이 된다.
 */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="60 60 392 392" aria-hidden="true">
      <defs>
        <mask id="logo-gap">
          <rect width="512" height="512" fill="#fff" />
          <circle cx="360.65" cy="151.35" r="50" fill="#000" />
        </mask>
      </defs>
      <circle cx="256" cy="256" r="148" fill="none" stroke="currentColor" strokeWidth="34" mask="url(#logo-gap)" />
      <circle cx="360.65" cy="151.35" r="28" fill="currentColor" />
    </svg>
  )
}
