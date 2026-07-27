import { Act } from '../components/Act'
import { Receive } from '../components/Receive'
import { useWraith } from '../hooks/useWraith'

export function ReceivePage() {
  const { receiveCode } = useWraith()
  return (
    <Act
      no="Act 04"
      id="act-cipher"
      title="Your cipher"
      standfirst="Your receive code. Share it to be paid privately; the sender encrypts to it, and it reveals nothing about your balance or history."
      coords={['Owner key', 'Enc pubkey']}
    >
      <Receive receiveCode={receiveCode} />
    </Act>
  )
}

export default ReceivePage
