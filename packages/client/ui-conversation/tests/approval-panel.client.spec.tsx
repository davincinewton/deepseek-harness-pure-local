// ApprovalFlow component tests: the three-answer approval panel — the
// session-wide button appears only on an advertised ask, sits behind the
// RiskConfirmation acknowledgement, and answers `allowed-full-access`.

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import type { ApprovalRequestId, ClientResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { PendingApproval } from '../src/client/contract/slots.ts'
import { ApprovalFlow } from '../src/client/skeleton/ApprovalPanel.tsx'

const t = (key: string): string => key

/** A real pending carrier over a stub responder, recording delivered outcomes. */
function wait(allowFullAccess?: true) {
  const sent: { outcome: string }[] = []
  const respond = vi.fn(async (message: ClientResponse) => {
    const result = message.result as { value: { outcome: string } }
    sent.push({ outcome: result.value.outcome })
    return { accepted: true } as const
  })
  const carrier = new PendingWait('approval', 'r1' as never, 's1' as never, {
    approvalId: 'a1' as unknown as ApprovalRequestId,
    toolName: 'bash',
    reason: 'touch a file outside the workspace',
    ...(allowFullAccess === true ? { allowFullAccess } : {}),
  }, respond)
  return { pending: new PendingApproval(carrier), respond, sent }
}

describe('ApprovalFlow', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders reject and allow-once only when the ask does not advertise the session-wide answer', () => {
    const { pending } = wait()
    render(<ApprovalFlow pending={pending} t={t} />)
    expect(screen.getByRole('button', { name: 'approval.reject' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'approval.allowOnce' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'approval.allowFullAccess' })).toBeNull()
  })

  it('the session-wide answer requires the confirmation acknowledgement before it is sent', () => {
    const { pending, respond, sent } = wait(true)
    render(<ApprovalFlow pending={pending} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'approval.allowFullAccess' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(respond).not.toHaveBeenCalled()
    const enable = screen.getByRole('button', { name: 'approval.fullAccess.enable' }) as HTMLButtonElement
    expect(enable.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(enable.disabled).toBe(false)
    fireEvent.click(enable)
    expect(respond).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([{ outcome: 'allowed-full-access' }])
  })

  it('cancelling the confirmation sends nothing and re-arms the buttons', () => {
    const { pending, respond, sent } = wait(true)
    render(<ApprovalFlow pending={pending} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'approval.allowFullAccess' }))
    fireEvent.click(screen.getByRole('button', { name: 'approval.fullAccess.cancel' }))
    expect(respond).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'approval.allowOnce' }))
    expect(sent).toEqual([{ outcome: 'allowed-once' }])
  })
})
