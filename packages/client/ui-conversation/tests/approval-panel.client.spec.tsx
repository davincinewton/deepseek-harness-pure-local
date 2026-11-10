// @vitest-environment jsdom
// ApprovalPanel behavior: the reject / allow-once actions, the "allow for
// session" action that exists exactly when the asker advertises `allowSession`,
// the one-shot disable latch, and the re-arm on a rejected carrier receipt.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcReceipt } from '@deepseek-ai/dsh-api-remotes/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { ApprovalPanel } from '../src/client/skeleton/ApprovalPanel.tsx'
import type { ApprovalComposerProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

afterEach(cleanup)

const SID = 's1' as SessionId

/** Seat stub over a dictionary pair mirroring the real lookup chain: package dictionary, then common vocabulary, then the key. */
const t: ApprovalComposerProps['t'] = ((key) => {
  const dict: Record<string, string> = zh
  const common: Record<string, string> = commonZh
  return dict[key] ?? common[key] ?? key
})

/** Carrier fixture: a real PendingWait over a scripted respond carrier. */
function wait(respond: () => Promise<RpcReceipt>, allowSession = false) {
  return new PendingWait('approval', RpcId('approval-1'), SID, {
    approvalId: 'ap-1',
    toolName: 'bash',
    reason: 'run a non-read-only command without a sandbox backend',
    ...allowSession ? { allowSession: true } : {},
  } as never, respond)
}

/** Framework standard-kit stubs: the panel consumes only the locale seat and the call lookup. */
function renderPanel(carrier: PendingWait<'approval'>) {
  const props = {
    matched: carrier,
    session: undefined,
    sessionId: SID,
    useSession: (() => undefined) as unknown as SnapshotSelectorHook<ConversationSnapshot>,
    useSessions: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
    useProjection: (() => undefined) as never,
    useInput: (() => { throw new Error('unused') }) as never,
    inputActions: { setDraft: vi.fn(), submit: vi.fn() } as never,
    t,
  } as unknown as ApprovalComposerProps
  return render(<ApprovalPanel {...props} />)
}

function envelope(outcome: string, rpcId = 'approval-1') {
  return {
    type: 'client-response',
    rpcId: RpcId(rpcId),
    result: { ok: true, value: { sessionId: SID, approvalId: 'ap-1', outcome } },
  }
}

const ACCEPTED = () => Promise.resolve<RpcReceipt>({ accepted: true })

describe('ApprovalPanel', () => {
  it('renders the question and answers reject / allow-once in the wire vocabulary', () => {
    const respond = vi.fn(ACCEPTED)
    renderPanel(wait(respond))

    expect(screen.getByText('run a non-read-only command without a sandbox backend')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    expect(respond).toHaveBeenCalledOnce()
    expect(respond).toHaveBeenCalledWith(envelope('allowed-once'))
  })

  it('hides "allow for session" unless the asker can record a grant', () => {
    renderPanel(wait(vi.fn(ACCEPTED)))
    expect(screen.queryByRole('button', { name: '本次会话内允许' })).toBeNull()
  })

  it('answers "allowed-for-session" on a grantable ask', () => {
    const respond = vi.fn(ACCEPTED)
    renderPanel(wait(respond, true))
    fireEvent.click(screen.getByRole('button', { name: '本次会话内允许' }))
    expect(respond).toHaveBeenCalledWith(envelope('allowed-for-session'))
  })

  it('disables every action after a click and re-arms on a rejected receipt', async () => {
    const respond = vi.fn(() => Promise.resolve<RpcReceipt>({ accepted: false, reason: 'bad-response' }))
    renderPanel(wait(respond, true))
    const allowOnce = screen.getByRole<HTMLButtonElement>('button', { name: '允许一次' })
    fireEvent.click(allowOnce)
    expect(allowOnce.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '本次会话内允许' }).disabled).toBe(true)
    // The carrier refused the answer: the one-shot latch reopens for retry.
    await vi.waitFor(() => { expect(allowOnce.disabled).toBe(false) })
  })

  it('answers reject in the wire vocabulary', () => {
    const respond = vi.fn(ACCEPTED)
    renderPanel(wait(respond, true))
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(respond).toHaveBeenCalledWith(envelope('rejected'))
  })
})
