import { useCallback, useState } from 'react'
import type { TxResult } from '../lib/obscura-sdk'

export type SubmitStatus = 'idle' | 'pending' | 'done' | 'error'

export interface SubmitState {
  status: SubmitStatus
  hash: string | null
  error: string | null
}

export interface Submitter {
  state: SubmitState
  submit: <T extends TxResult>(action: () => Promise<T>) => Promise<T | null>
  reset: () => void
}

/**
 * Simple async-submit state machine for flows without a proof overlay
 * (Bridge deposit/withdraw): tracks pending/done/error and the returned hash.
 */
export function useSubmit(): Submitter {
  const [state, setState] = useState<SubmitState>({ status: 'idle', hash: null, error: null })

  const submit = useCallback(async <T extends TxResult>(action: () => Promise<T>): Promise<T | null> => {
    setState({ status: 'pending', hash: null, error: null })
    try {
      const result = await action()
      setState({ status: 'done', hash: result.hash, error: null })
      return result
    } catch (err) {
      setState({
        status: 'error',
        hash: null,
        error: err instanceof Error ? err.message : 'Transaction failed.',
      })
      return null
    }
  }, [])

  const reset = useCallback(() => {
    setState({ status: 'idle', hash: null, error: null })
  }, [])

  return { state, submit, reset }
}
