import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createScope } from 'stm'
import { ScopeProvider } from 'stm-react'
import { api } from './api'
import { App } from './App'

const scope = createScope({ api })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ScopeProvider value={scope}>
      <App />
    </ScopeProvider>
  </StrictMode>,
)
