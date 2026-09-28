import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startLedgerHeadPoll } from '../../lib/network/ledgerPoller'
import { callRpc } from '../../lib/network/rpcClient'
import { getStoreState, resetStore } from '../../store/lensStore'
import { ConnectionStatus } from '../../store/types'

vi.mock('../../lib/network/rpcClient', () => ({
  callRpc: vi.fn(),
}))

const mockCallRpc = vi.mocked(callRpc)

describe('startLedgerHeadPoll', () => {
  const defaultRpcConfig = {
    url: 'https://rpc.example.com',
    timeout: 5000,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetStore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('emits changes only on sequence increment', () => {
    it('calls onLedgerChange when sequence increases', async () => {
      const onLedgerChange = vi.fn()
      mockCallRpc
        .mockResolvedValueOnce({ result: { sequence: 100 } })
        .mockResolvedValueOnce({ result: { sequence: 101 } })
        .mockResolvedValueOnce({ result: { sequence: 102 } })

      const stop = startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        intervalMs: 1000,
        onLedgerChange,
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(onLedgerChange).toHaveBeenCalledWith(100)
      await vi.advanceTimersByTimeAsync(1000)
      expect(onLedgerChange).toHaveBeenCalledWith(101)
      await vi.advanceTimersByTimeAsync(1000)
      expect(onLedgerChange).toHaveBeenCalledWith(102)
      expect(onLedgerChange).toHaveBeenCalledTimes(3)
      stop()
    })

    it('does not call onLedgerChange when sequence is unchanged', async () => {
      const onLedgerChange = vi.fn()
      mockCallRpc
        .mockResolvedValueOnce({ result: { sequence: 100 } })
        .mockResolvedValueOnce({ result: { sequence: 100 } })
        .mockResolvedValueOnce({ result: { sequence: 100 } })

      const stop = startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        intervalMs: 1000,
        onLedgerChange,
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(onLedgerChange).toHaveBeenCalledTimes(1)
      expect(onLedgerChange).toHaveBeenCalledWith(100)
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(onLedgerChange).toHaveBeenCalledTimes(1)
      stop()
    })

    it('does not call onLedgerChange when sequence decreases', async () => {
      const onLedgerChange = vi.fn()
      mockCallRpc
        .mockResolvedValueOnce({ result: { sequence: 102 } })
        .mockResolvedValueOnce({ result: { sequence: 101 } })
        .mockResolvedValueOnce({ result: { sequence: 100 } })

      const stop = startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        intervalMs: 1000,
        onLedgerChange,
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(onLedgerChange).toHaveBeenCalledWith(102)
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(onLedgerChange).toHaveBeenCalledTimes(1)
      stop()
    })

    it('calls onLedgerChange only for first poll when result has no sequence then valid sequence', async () => {
      const onLedgerChange = vi.fn()
      mockCallRpc
        .mockResolvedValueOnce({ result: {} })
        .mockResolvedValueOnce({ result: { sequence: 100 } })

      const stop = startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        intervalMs: 1000,
        onLedgerChange,
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(onLedgerChange).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1000)
      expect(onLedgerChange).toHaveBeenCalledTimes(1)
      expect(onLedgerChange).toHaveBeenCalledWith(100)
      stop()
    })

    it('does not call onLedgerChange when RPC returns error', async () => {
      const onLedgerChange = vi.fn()
      mockCallRpc.mockResolvedValue({
        message: 'Network error',
        code: 'NETWORK_ERROR',
      })

      const stop = startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        intervalMs: 1000,
        onLedgerChange,
      })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(onLedgerChange).not.toHaveBeenCalled()
      expect(getStoreState().connectionStatus).toBe(ConnectionStatus.ERROR)
      stop()
    })

    it('reports failure and recovery through connection status callbacks', async () => {
      mockCallRpc
        .mockResolvedValueOnce({
          message: 'Network error',
          code: 'NETWORK_ERROR',
        })
        .mockResolvedValueOnce({ result: { sequence: 100 } })
      const onError = vi.fn()
      const onRecovery = vi.fn()
      const stop = startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        intervalMs: 1000,
        onLedgerChange: vi.fn(),
        onError,
        onRecovery,
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(getStoreState().connectionStatus).toBe(ConnectionStatus.ERROR)
      expect(onError).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1000)
      expect(getStoreState().connectionStatus).toBe(ConnectionStatus.SUCCESS)
      expect(onRecovery).toHaveBeenCalledOnce()
      stop()
    })

    it('polls immediately when the document becomes visible again', async () => {
      mockCallRpc.mockResolvedValue({ result: { sequence: 100 } })
      const stop = startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        intervalMs: 10000,
        onLedgerChange: vi.fn(),
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(mockCallRpc).toHaveBeenCalledTimes(1)
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(mockCallRpc).toHaveBeenCalledTimes(1)
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(mockCallRpc).toHaveBeenCalledTimes(2)
      stop()
    })
  })

  describe('stop function', () => {
    it('halts further polling and callbacks after stop', async () => {
      const onLedgerChange = vi.fn()
      mockCallRpc
        .mockResolvedValueOnce({ result: { sequence: 100 } })
        .mockResolvedValueOnce({ result: { sequence: 101 } })
        .mockResolvedValueOnce({ result: { sequence: 102 } })

      const stop = startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        intervalMs: 1000,
        onLedgerChange,
      })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockCallRpc).toHaveBeenCalledTimes(3)
      expect(onLedgerChange).toHaveBeenCalledTimes(3)

      stop()

      await vi.advanceTimersByTimeAsync(5000)
      expect(mockCallRpc).toHaveBeenCalledTimes(3)
      expect(onLedgerChange).toHaveBeenCalledTimes(3)
    })

    it('stop is idempotent', async () => {
      mockCallRpc.mockResolvedValue({ result: { sequence: 100 } })
      const stop = startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        intervalMs: 1000,
        onLedgerChange: vi.fn(),
      })

      await vi.advanceTimersByTimeAsync(0)
      stop()
      stop()
      stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(mockCallRpc).toHaveBeenCalledTimes(1)
    })

    it('aborts the active latest-ledger request when stopped', () => {
      let requestSignal: AbortSignal | undefined
      mockCallRpc.mockImplementation((_config, _body, signal) => {
        requestSignal = signal
        return new Promise(() => {})
      })
      const stop = startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        intervalMs: 1000,
        onLedgerChange: vi.fn(),
      })

      expect(requestSignal?.aborted).toBe(false)
      stop()

      expect(requestSignal?.aborted).toBe(true)
    })
  })

  describe('configurable options', () => {
    it('uses default interval 5000ms when intervalMs omitted', async () => {
      mockCallRpc.mockResolvedValue({ result: { sequence: 1 } })
      const onLedgerChange = vi.fn()

      startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        onLedgerChange,
      })

      expect(mockCallRpc).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(4999)
      expect(mockCallRpc).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockCallRpc).toHaveBeenCalledTimes(2)
    })

    it('uses custom interval when intervalMs provided', async () => {
      mockCallRpc.mockResolvedValue({ result: { sequence: 1 } })

      startLedgerHeadPoll({
        rpcConfig: defaultRpcConfig,
        intervalMs: 2000,
        onLedgerChange: vi.fn(),
      })

      expect(mockCallRpc).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1999)
      expect(mockCallRpc).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockCallRpc).toHaveBeenCalledTimes(2)
    })

    it('passes rpcConfig to callRpc', async () => {
      const config = {
        url: 'https://custom.rpc.url',
        timeout: 10000,
        headers: { 'X-Custom': 'value' },
      }
      mockCallRpc.mockResolvedValue({ result: { sequence: 1 } })

      const stop = startLedgerHeadPoll({
        rpcConfig: config,
        intervalMs: 10000,
        onLedgerChange: vi.fn(),
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(mockCallRpc).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'getLatestLedger',
        }),
        expect.any(AbortSignal),
      )
      stop()
    })
  })
})
