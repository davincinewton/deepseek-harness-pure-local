/**
 * approvals domain contract. The approval requested frame is a
 * server-request (stable rpcId); the answer is a client-response echoing that rpcId (not a
 * unary method, not in RpcMethodMap, mints no new id), carried on POST /api/respond with an
 * RpcReceipt carrier receipt as the HTTP response body; the final outcome arrives in the resolved frame.
 */

import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Approval answer payload (the result.value slot of a client-response). outcome accepts only
 * the values a client can give (cancelled/unavailable are host-side outcomes);
 * `'allowed-for-session'` answers an ask whose asker advertised `allowSession` and records a
 * durable session grant. approvalId is the core audit correlation (used by the impl to
 * reconcile `approval/asked`/`decided`; passes through core's existing brand); wire correlation
 * is governed by the echoed rpcId.
 */
export interface ApprovalResponsePayload {
  sessionId: SessionId
  approvalId: ApprovalRequestId
  outcome: 'allowed-once' | 'allowed-for-session' | 'rejected'
}
