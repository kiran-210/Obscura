import { Address, xdr } from '@stellar/stellar-sdk'

const depositValue =
  'AAAAEQAAAAEAAAADAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAA7msoAAAAADwAAAAVhc3NldAAAAAAAABIAAAAB15KLcsJwPM/q9+uf9O9NUEpVqLl5/JtFDqLIQrTRzmEAAAAPAAAACmNvbW1pdG1lbnQAAAAAAA0AAAAgJogq0av2hYRzhSzFmO0nvMdsz9kDmYju05RlfHwgqqw='

const v = xdr.ScVal.fromXDR(depositValue, 'base64')
for (const entry of v.map()) {
  const k = entry.key().sym().toString()
  const val = entry.val()
  if (k === 'amount') {
    const lo = val.i128().lo().toString()
    console.log(`amount    = ${lo} base units  = ${Number(lo) / 1e7} (7dp)`)
  } else if (k === 'asset') {
    console.log(`asset     = ${Address.fromScVal(val).toString()}`)
  } else {
    console.log(`${k} = <${val.switch().name}>`)
  }
}

console.log('\n--- known contracts ---')
console.log('native SAC (ours)   CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC')
console.log('faucet USDC (upstream) CB4F54CW6HRI57QUNOLBA3PWA6BTH65CXGJ6O7FNEDTU6OT6O6AMORMG')
