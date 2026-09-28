import { buildJsonRpcRequest } from '../rpc/buildJsonRpcRequest'
import { toRpcRequestId } from '../rpc/toRpcRequestId'
import { useLensStore } from '../../store/lensStore'
import { ConnectionStatus } from '../../store/types'
import { callRpc } from './rpcClient'
import type { LatestLedgerResult, RpcConfig, RpcError } from './types'

export interface LedgerHeadPollOptions {
  rpcConfig: RpcConfig
  intervalMs?: number
  onLedgerChange: (sequence: number) => void
  onError?: (error: Error) => void
  onRecovery?: () => void
}

const DEFAULT_INTERVAL_MS = 5000

function isRpcError(value: unknown): value is RpcError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof (value as RpcError).message === 'string'
  )
}

export function startLedgerHeadPoll(
  options: LedgerHeadPollOptions,
): () => void {
  const {
    rpcConfig,
    intervalMs = DEFAULT_INTERVAL_MS,
    onLedgerChange,
    onError,
    onRecovery,
  } = options

  let lastSequence: number | null = null
  const stoppedRef = { current: false }
  let activeController: AbortController | null = null

  const reportFailure = (error: Error): void => {
    const wasError =
      useLensStore.getState().connectionStatus === ConnectionStatus.ERROR
    useLensStore.getState().setConnectionStatus(ConnectionStatus.ERROR)
    if (!wasError) onError?.(error)
  }

  const tick = async (): Promise<void> => {
    if (stoppedRef.current || activeController) return
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    ) {
      return
    }

    const body = buildJsonRpcRequest('getLatestLedger', {}, toRpcRequestId())
    const controller = new AbortController()
    activeController = controller

    try {
      const response = await callRpc<{ result?: LatestLedgerResult }>(
        rpcConfig,
        body,
        controller.signal,
      )

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() can run during await
      if (stoppedRef.current) return
      if (isRpcError(response)) {
        reportFailure(new Error(response.message || 'Connection failed'))
        return
      }

      const result = response.result
      if (
        result == null ||
        typeof result !== 'object' ||
        typeof result.sequence !== 'number' ||
        !Number.isFinite(result.sequence)
      ) {
        reportFailure(new Error('Invalid response from RPC server'))
        return
      }

      const wasError =
        useLensStore.getState().connectionStatus === ConnectionStatus.ERROR
      useLensStore.getState().setConnectionStatus(ConnectionStatus.SUCCESS)
      if (wasError) onRecovery?.()

      const { sequence } = result
      if (lastSequence === null || sequence > lastSequence) {
        lastSequence = sequence
        onLedgerChange(sequence)
      }
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() can run during await
      if (!stoppedRef.current) {
        reportFailure(
          error instanceof Error ? error : new Error('Connection failed'),
        )
      }
    } finally {
      activeController = null
    }
  }

  useLensStore.getState().setConnectionStatus(ConnectionStatus.LOADING)
  const intervalId = setInterval(tick, intervalMs)
  tick()
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') void tick()
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  return function stop(): void {
    if (stoppedRef.current) return
    stoppedRef.current = true
    clearInterval(intervalId)
    activeController?.abort()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }
}
