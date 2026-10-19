import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { saveComposerDraftFromDom } from './lib/composer-draft'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Kim root element was not found')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary
      onCatch={saveComposerDraftFromDom}
      fallback={(
        <div className="empty-state app-error-fallback" role="alert">
          <h2>Kim 遇到了意外错误</h2>
          <p>重新加载即可继续，正在输入的内容会保留。</p>
          <div className="empty-state__action">
            <button type="button" className="button button--primary" onClick={() => window.location.reload()}>重新加载 Kim</button>
          </div>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
