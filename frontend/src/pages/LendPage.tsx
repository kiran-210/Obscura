import { Act } from '../components/Act'
import { Lend } from '../components/Lend'

export function LendPage() {
  return (
    <Act
      no="Act 04"
      id="act-ledger"
      title="The quiet ledger"
      standfirst="Borrow against a shielded position. Your collateral is public so anyone can liquidate it fairly — how far you are leveraged is nobody's business."
      coords={['Public collateral', 'Private debt']}
      maxWidthClassName="max-w-3xl"
    >
      <Lend embedded />
    </Act>
  )
}

export default LendPage
