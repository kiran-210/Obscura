import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { Landing } from './components/Landing'
import { BrandCanvas } from './components/BrandCanvas'
import { AppLayout } from './components/AppLayout'
import { Faucet } from './components/Faucet'
import { Hub } from './pages/Hub'
import { PortfolioPage } from './pages/PortfolioPage'
import { BridgePage } from './pages/BridgePage'
import { PayPage } from './pages/PayPage'
import { SwapPage } from './pages/SwapPage'
import { ReceivePage } from './pages/ReceivePage'

// Routes: the moody monopo landing at "/", then the shielded app as separate
// pages under a shared shell — hub at "/app", and Bridge/Pay/Swap/Receive each
// on their own route. The testnet faucet keeps its own standalone surface.

function LandingRoute() {
  const navigate = useNavigate()
  return <Landing onEnter={() => navigate('/app')} />
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingRoute />} />
      <Route element={<AppLayout />}>
        <Route path="/app" element={<Hub />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route path="/deposit" element={<BridgePage />} />
        <Route path="/pay" element={<PayPage />} />
        <Route path="/swap" element={<SwapPage />} />
        <Route path="/receive" element={<ReceivePage />} />
        {/* Deposit/Withdraw was previously "Bridge" — keep old links working. */}
        <Route path="/bridge" element={<Navigate to="/deposit" replace />} />
      </Route>
      <Route
        path="/faucet"
        element={
          <>
            <BrandCanvas />
            <Faucet />
          </>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
