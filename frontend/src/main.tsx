import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { WalletProvider } from './hooks/useWallet'
import { ObscuraProvider } from './hooks/useObscura'
import { RevealProvider } from './hooks/useReveal'
import './index.css'

// @stellar/stellar-sdk (stellar-base) relies on a global Buffer in the browser.
if (!globalThis.Buffer) globalThis.Buffer = Buffer

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

// One shared TanStack Query client for the app's data hooks.
const queryClient = new QueryClient()

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <WalletProvider>
          <ObscuraProvider>
            <RevealProvider>
              <App />
            </RevealProvider>
          </ObscuraProvider>
        </WalletProvider>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
)
