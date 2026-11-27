import { expect, it } from 'vitest'
import { choiceOpen } from '../src/core/terminal'

// 실제 Claude Code 2.1.332 · Codex 0.172.0 화면에서 가져온 문구
const claudeTrust = '\x1b[1mQuick safety check: Is this a project you created or one you trust?\x1b[0m\r\n❯ No, exit\r\n  Yes, I trust this folder\r\n\r\nEnter to confirm · Esc to cancel'
const claudeComposer = '\r\n────────\r\n❯ \r\n────────\r\n  ⏵⏵ auto mode on ◐ medium · /effort (shift+tab to cycle) · ← for agents'
const codexComposer = '› Ask Codex to do anything\r\n  ? for shortcuts'
const codexSandbox = 'Set up the Codex agent sandbox to protect your files\r\n› 1. Set up default sandbox (requires Administrator permissions)\r\n  2. Use non-admin sandbox\r\n  3. Quit\r\nenter select · esc back'
const codexUpdate = 'Update available! 0.169.0 -> 0.172.0\r\n› 1. Update now\r\n  2. Skip\r\nenter continue · esc skip'

it('선택 창 문구가 입력창보다 뒤에 있으면 선택 창이 떠 있다고 본다', () => {
  expect(choiceOpen(claudeTrust)).toBe(true)
  expect(choiceOpen(claudeTrust + claudeComposer)).toBe(false)
  // Codex는 입력창을 그린 뒤에 샌드박스·업데이트 창을 띄운다
  expect(choiceOpen(codexComposer + codexSandbox)).toBe(true)
  expect(choiceOpen(codexComposer + codexUpdate)).toBe(true)
  expect(choiceOpen(codexComposer + codexSandbox + '\x1b[2J' + codexComposer)).toBe(false)
  // 선택 창이 없으면 입력창 문구가 안 보여도 막지 않는다
  expect(choiceOpen('Welcome\r\n> ')).toBe(false)
  expect(choiceOpen('')).toBe(false)
})
