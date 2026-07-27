import { Act } from '../components/Act'
import { Pay } from '../components/Pay'

export function PayPage() {
  return (
    <Act
      no="Act 02"
      id="act-send"
      title="Send into the dark"
      standfirst="A 2-in / 2-out shielded transfer. Amounts and both parties stay hidden; on-chain, observers see only two opaque commitments and a valid proof."
      coords={['Poseidon · Merkle', '2-in · 2-out']}
    >
      <Pay embedded />
    </Act>
  )
}

export default PayPage
