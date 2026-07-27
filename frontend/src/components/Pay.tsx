import { useState } from 'react'
import { useWraith } from '../hooks/useWraith'
import { useProofFlow } from '../hooks/useProofFlow'
import { TOKEN_OPTIONS } from '../lib/tokens'
import { isPositiveAmount } from '../lib/format'
import type { AssetCode } from '../lib/wraith-sdk'
import { Button, Card, Field, PageIntro, SectionHeading, Select, ShieldIcon, TextInput } from './ui'
import { ProofProgress } from './ProofProgress'

export function Pay({ embedded }: { embedded?: boolean } = {}) {
  const { sdk, refreshBalances } = useWraith()
  const proof = useProofFlow()

  const [recipientKey, setRecipientKey] = useState('')
  const [asset, setAsset] = useState<AssetCode>('XLM')
  const [amount, setAmount] = useState('')

  const valid = recipientKey.trim().length >= 8 && isPositiveAmount(amount)

  async function onSend() {
    const result = await proof.run(() =>
      sdk.transfer({ recipientKey: recipientKey.trim(), asset, amount }),
    )
    if (result) await refreshBalances()
  }

  function closeOverlay() {
    const succeeded = proof.status === 'done'
    proof.reset()
    if (succeeded) {
      setAmount('')
      setRecipientKey('')
    }
  }

  return (
    <div className={embedded ? 'space-y-5' : 'space-y-6'}>
      {!embedded && (
        <PageIntro title="Pay" subtitle="Send a private payment with the amount and participants hidden on-chain." />
      )}

      <Card className={embedded ? 'p-5' : 'mx-auto max-w-xl p-6'}>
        <SectionHeading icon={<ShieldIcon className="h-4 w-4" />} title="Private transfer" hint="ZK-proven" />
        <div className="mt-5 space-y-4">
          <Field
            label="Recipient code"
            hint="The recipient's Wraith receive code (wr1…) from their Receive screen — the payment is encrypted to it."
          >
            <TextInput
              mono
              placeholder="wr1…"
              value={recipientKey}
              onChange={(e) => setRecipientKey(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Asset">
              <Select
                value={asset}
                onChange={(e) => setAsset(e.target.value as AssetCode)}
                options={TOKEN_OPTIONS}
              />
            </Field>
            <Field label="Amount">
              <TextInput
                mono
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          </div>
          <Button className="w-full" disabled={!valid} onClick={() => void onSend()}>
            Send privately
          </Button>
          <p className="text-center text-xs text-zinc-600">
            On-chain, observers see only two opaque commitments and a valid proof — no amount, no parties.
          </p>
        </div>
      </Card>

      <ProofProgress
        flow={proof}
        title="Sending private payment"
        subject={isPositiveAmount(amount) ? `${amount} ${asset}` : undefined}
        onClose={closeOverlay}
      />
    </div>
  )
}
