#!/usr/bin/env bash
# End-to-end private round-trip against a live deployment: deposit 1 XLM, then
# withdraw it with a real ZK proof. Reads contract ids from deployments.json.
# Prereqs: `source ./env.sh`; `pnpm --filter @wraith/sdk build`; deployments.json present.
set -euo pipefail
cd "$(dirname "$0")/.."

IDENT="${IDENT:-wraith-deployer}"
NET="${NET:-testnet}"
POOL=$(node -e "console.log(require('./deployments.json').contracts.wraithPool)")
NATIVE=$(node -e "console.log(require('./deployments.json').contracts.assets.native)")
DEPLOYER=$(stellar keys address "$IDENT")

# Deterministic demo note.
SK=12345; BL=67890; AMT=10000000   # 1 XLM, asset_id=0 (native)

echo "==> Computing commitment (SDK)"
COMMIT=$(node -e "
import('./sdk/dist/index.js').then(m=>{
  const n=m.createNote({assetId:0n,amount:${AMT}n,spendingKey:${SK}n,blinding:${BL}n,leafIndex:0});
  process.stdout.write(Buffer.from(m.fieldToBytes(n.commitment)).toString('hex'));
});")
echo "    commitment=$COMMIT"

echo "==> deposit $AMT stroops"
stellar contract invoke --id "$POOL" --source "$IDENT" --network "$NET" --send yes \
  -- deposit --from "$IDENT" --asset "$NATIVE" --amount "$AMT" --commitment "$COMMIT"

echo "==> building withdraw witness (root must match on-chain)"
node -e "
import('./sdk/dist/index.js').then(m=>{
  const sk=${SK}n, bl=${BL}n, amt=${AMT}n;
  const ok=m.deriveOwnerKey(sk);
  const c=m.computeCommitment(0n,amt,ok,bl);
  const nf=m.computeNullifier(c,sk);
  const t=new m.MerkleTree(); t.insert(c);
  const rh=m.hash2(m.addressToField('$DEPLOYER'),0n);
  const path=[]; for(let i=0;i<20;i++) path.push(ZEROS_(m,i));
  function ZEROS_(m,i){return m.ZEROS[i];}
  const q=a=>'['+a.map(x=>'\"'+x.toString()+'\"').join(',')+']';
  const toml='merkle_root = \"'+t.root+'\"\n'+
    'nullifier = \"'+nf+'\"\nrecipient_hash = \"'+rh+'\"\namount = \"'+amt+'\"\nasset_id = \"0\"\n'+
    'note_amount = \"'+amt+'\"\nnote_asset_id = \"0\"\nnote_blinding = \"'+bl+'\"\nspending_key = \"'+sk+'\"\n'+
    'merkle_path = '+q(path)+'\nmerkle_indices = '+q(Array(20).fill(0n))+'\n';
  require('fs').writeFileSync('circuits/noir/withdraw/Prover.toml', toml);
});"

echo "==> proving (nargo + bb)"
( cd circuits/noir/withdraw
  nargo execute witness >/dev/null
  bb prove --scheme ultra_honk --oracle_hash keccak -b target/withdraw.json -w target/witness.gz -o target --output_format bytes_and_fields >/dev/null )

echo "==> withdraw with real proof"
stellar contract invoke --id "$POOL" --source "$IDENT" --network "$NET" --send yes \
  -- withdraw \
  --proof-file-path circuits/noir/withdraw/target/proof \
  --public_inputs-file-path circuits/noir/withdraw/target/public_inputs \
  --recipient "$IDENT" --amount "$AMT" --asset "$NATIVE"

echo "==> DONE: deposit + ZK withdraw verified on-chain."
