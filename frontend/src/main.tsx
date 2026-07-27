import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import App from './App'
import { WalletProvider } from './hooks/useWallet'
import { WraithProvider } from './hooks/useWraith'
import { RevealProvider } from './hooks/useReveal'
import { wagmiConfig } from './lib/wagmi'
import './index.css'

// @stellar/stellar-sdk (stellar-base) relies on a global Buffer in the browser.
if (!globalThis.Buffer) globalThis.Buffer = Buffer

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

// One shared TanStack Query client backs wagmi's data hooks (required by wagmi v2).
const queryClient = new QueryClient()

createRoot(rootElement).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <WalletProvider>
            <WraithProvider>
              <RevealProvider>
                <App />
              </RevealProvider>
            </WraithProvider>
          </WalletProvider>
        </HashRouter>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
