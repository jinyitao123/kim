import { ChevronRight, ExternalLink, Gauge, KeyRound, LogIn, LogOut, RefreshCw, Search, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import type { HarnessId, PrimeModelCatalog, PrimeModelDescriptor, PrimeProviderDescriptor } from '@/types/api'
import { HARNESS_AGENT_NAMES } from '@/lib/harness'
import { Modal } from '@/components/ui'

interface ProviderSettingsProps {
  /** Credentials are saved in this app's private profile for the active assistant. */
  harness?: HarnessId
  catalog: PrimeModelCatalog | null
  onRefresh(): Promise<void>
  onSaveApiKey(providerId: string, apiKey: string): Promise<void>
  onLogout(providerId: string): Promise<void>
  onSetEnabled(providerId: string, enabled: boolean): Promise<void>
  onSetAllEnabled(): Promise<void>
  onSetAllDisabled(): Promise<void>
  onSetModelEnabled(modelKey: string, enabled: boolean): Promise<void>
  onStartOAuth(providerId: string): Promise<void>
  onOpenDocs(): void
}

function authDescription(provider: PrimeProviderDescriptor): string {
  if (!provider.configured) return provider.authMethod === 'external' ? '使用在 Kim 之外配置的凭据' : '未连接'
  const source = provider.authSource === 'environment' ? provider.authLabel ? `环境变量 · ${provider.authLabel}` : '环境变量'
    : provider.authSource === 'prime_cli' ? 'Prime CLI 账号'
      : provider.authSource === 'models_json_key' || provider.authSource === 'models_json_command' ? 'models.json'
        : provider.authSource === 'stored' ? provider.authMethod === 'oauth' ? '已连接账号' : '已保存的 API 密钥'
          : provider.authSource ?? '已配置'
  return `${source} · 可用 ${provider.availableModelCount.toLocaleString()} 个模型`
}

function activeFirst<T extends { enabled?: boolean }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => Number(right.enabled !== false) - Number(left.enabled !== false))
}

export function ProviderSettings({ harness = 'prime', catalog, onRefresh, onSaveApiKey, onLogout, onSetEnabled, onSetAllEnabled, onSetAllDisabled, onSetModelEnabled, onStartOAuth, onOpenDocs }: ProviderSettingsProps) {
  const externalAuth = harness !== 'prime' && !catalog?.providers.some(provider => provider.authMethod === 'api_key')
  const agentName = HARNESS_AGENT_NAMES[harness]
  const [view, setView] = useState<'providers' | 'models'>('providers')
  const [query, setQuery] = useState('')
  const [apiKeyProvider, setApiKeyProvider] = useState<PrimeProviderDescriptor | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [collapsedModelProviders, setCollapsedModelProviders] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState('')
  const [apiKeyError, setApiKeyError] = useState('')
  const providers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const matches = normalized
      ? (catalog?.providers ?? []).filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(normalized))
      : catalog?.providers ?? []
    return activeFirst(matches)
  }, [catalog, query])
  const providerNames = useMemo(() => new Map((catalog?.providers ?? []).map((provider) => [provider.id, provider.name])), [catalog])
  const modelGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const matches = normalized
      ? (catalog?.models ?? []).filter((model) => `${model.name} ${model.id} ${model.provider} ${providerNames.get(model.provider) ?? ''}`.toLowerCase().includes(normalized))
      : catalog?.models ?? []
    const byProvider = new Map<string, PrimeModelDescriptor[]>()
    for (const model of matches) {
      const models = byProvider.get(model.provider)
      if (models) models.push(model)
      else byProvider.set(model.provider, [model])
    }
    const orderedProviders = activeFirst(catalog?.providers ?? [])
    const groups = orderedProviders.flatMap((provider) => {
      const models = byProvider.get(provider.id)
      if (!models?.length) return []
      byProvider.delete(provider.id)
      return [{ provider, models: activeFirst(models) }]
    })
    for (const [providerId, models] of byProvider) {
      groups.push({
        provider: { id: providerId, name: providerNames.get(providerId) ?? providerId, authMethod: 'external', configured: false, modelCount: models.length, availableModelCount: 0, enabled: models.some((model) => model.enabled !== false) },
        models: activeFirst(models),
      })
    }
    return groups
  }, [catalog, providerNames, query])

  const run = async (providerId: string, action: () => Promise<void>) => {
    setBusyProvider(providerId); setError('')
    try { await action() } catch (failure) { setError(errorMessage(failure)) } finally { setBusyProvider(null) }
  }

  const saveApiKey = async () => {
    const provider = apiKeyProvider
    if (!provider || !apiKey.trim()) return
    setBusyProvider(provider.id)
    setApiKeyError('')
    try {
      await onSaveApiKey(provider.id, apiKey)
      setApiKey('')
      setApiKeyProvider(null)
    } catch (failure) {
      setApiKeyError(errorMessage(failure))
    } finally {
      setBusyProvider(null)
    }
  }

  const closeApiKey = () => { setApiKey(''); setApiKeyError(''); setApiKeyProvider(null) }
  const toggleModelProvider = (providerId: string) => setCollapsedModelProviders((current) => {
    const next = new Set(current)
    if (next.has(providerId)) next.delete(providerId)
    else next.add(providerId)
    return next
  })
  const enableAll = () => run('enable-all', onSetAllEnabled)
  const disableAll = () => run('disable-all', onSetAllDisabled)

  const providerCount = catalog?.providers.length ?? 0
  const modelCount = catalog?.models.length ?? 0
  const availableModelCount = catalog?.models.filter((model) => model.available && model.enabled !== false).length ?? 0
  const disabledCount = catalog?.providers.filter((provider) => !provider.enabled).length ?? 0

  return (
    <section className="settings-group provider-settings">
      <div className="settings-group__heading"><h2>{agentName} 目录</h2><div className="provider-heading-actions">{catalog && disabledCount < providerCount ? <button type="button" className="button button--danger" disabled={Boolean(busyProvider)} onClick={() => void disableAll()}>{externalAuth ? '全部隐藏' : '全部停用'}</button> : null}{disabledCount ? <button type="button" className="button" disabled={Boolean(busyProvider)} onClick={() => void enableAll()}>{externalAuth ? '全部显示' : '全部启用'}</button> : null}<button type="button" className="button button--icon" aria-label="刷新服务商" disabled={Boolean(busyProvider)} onClick={() => void run('refresh', onRefresh)}><RefreshCw size={13} /></button></div></div>
      <div className="provider-catalog-summary"><strong>{catalog ? `${providerCount.toLocaleString()} 个服务商 · ${modelCount.toLocaleString()} 个模型` : '正在加载服务商目录…'}</strong>{catalog ? <small>{externalAuth ? `Kim 中显示 ${availableModelCount.toLocaleString()} 个模型；${agentName} 会在启动时检查凭据` : `当前 ${agentName} 凭据可用 ${availableModelCount.toLocaleString()} 个模型`}</small> : null}</div>
      {catalog?.warning ? <p className="provider-catalog-warning" role="status">{catalog.warning}</p> : null}
      <div className="provider-catalog-tabs" role="tablist" aria-label="服务商目录视图">
        <button type="button" role="tab" aria-selected={view === 'providers'} className={view === 'providers' ? 'is-active' : ''} onClick={() => { setView('providers'); setQuery('') }}>服务商 <span>{providerCount.toLocaleString()}</span></button>
        <button type="button" role="tab" aria-selected={view === 'models'} className={view === 'models' ? 'is-active' : ''} onClick={() => { setView('models'); setQuery('') }}>模型 <span>{modelCount.toLocaleString()}</span></button>
      </div>
      <label className="provider-search"><Search size={13} /><input value={query} placeholder={view === 'providers' ? '搜索服务商' : '搜索模型'} aria-label={view === 'providers' ? '搜索服务商' : '搜索模型'} onChange={(event) => setQuery(event.target.value)} /></label>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {view === 'providers' ? <div className="provider-list">
        {providers.map((provider) => {
          const busy = busyProvider === provider.id
          return <div className="provider-row" key={provider.id}>
            <label className="provider-row__toggle" title={provider.enabled ? `在 ${agentName} 中隐藏服务商` : `在 ${agentName} 中显示服务商`}><input type="checkbox" aria-label={`显示服务商 ${provider.name}`} checked={provider.enabled} disabled={busy} onChange={(event) => void run(provider.id, () => onSetEnabled(provider.id, event.target.checked))} /><i aria-hidden="true"><span /></i></label>
            <div className="provider-row__identity"><strong>{provider.name}</strong><small>{externalAuth ? `${provider.authLabel ?? `凭据由 ${harness} CLI 管理`} · ${provider.availableModelCount.toLocaleString()} 个模型` : authDescription(provider)}</small></div>
            {externalAuth ? <div className="provider-row__actions"><button type="button" className="button" onClick={onOpenDocs}><ExternalLink size={13} /> 凭据设置</button></div> : <div className="provider-row__actions">
              {provider.authMethod === 'oauth' ? <button type="button" className="button" disabled={busy} onClick={() => void run(provider.id, () => onStartOAuth(provider.id))}><LogIn size={13} /> {provider.configured ? '重新连接' : '连接'}</button> : null}
              {provider.authMethod === 'api_key' ? <button type="button" className="button" disabled={busy} onClick={() => { setError(''); setApiKeyError(''); setApiKey(''); setApiKeyProvider(provider) }}><KeyRound size={13} /> {provider.configured ? '更换密钥' : '添加密钥'}</button> : null}
              {provider.authMethod === 'external' ? <button type="button" className="button" onClick={onOpenDocs}><ExternalLink size={13} /> Setup</button> : null}
              {provider.configured && provider.authSource === 'stored' ? <button type="button" className="button button--icon" aria-label={`退出 ${provider.name}`} disabled={busy} onClick={() => void run(provider.id, () => onLogout(provider.id))}><LogOut size={13} /></button> : null}
            </div>}
          </div>
        })}
      </div> : <div className="provider-list provider-model-list">
        {modelGroups.map(({ provider, models }) => {
          const collapsed = collapsedModelProviders.has(provider.id)
          const contentId = `provider-models-${provider.id.replace(/[^a-z0-9_-]/gi, '-')}`
          return <div className={`provider-model-group${provider.enabled ? '' : ' is-disabled'}${collapsed ? ' is-collapsed' : ''}`} key={provider.id}>
          <button type="button" className="provider-model-group__heading" aria-expanded={!collapsed} aria-controls={contentId} onClick={() => toggleModelProvider(provider.id)}><strong>{provider.name}</strong><small>已开 {models.filter((model) => model.enabled !== false).length.toLocaleString()}/{models.length.toLocaleString()}</small><ChevronRight className="provider-model-group__chevron" size={13} aria-hidden="true" /></button>
          <div id={contentId} className="provider-model-group__models" hidden={collapsed}>{models.map((model) => <div className={`provider-model-row${model.enabled === false ? ' is-disabled' : ''}`} key={model.key}>
            <div className="provider-row__identity"><strong>{model.name}</strong><small>{model.id}</small></div>
            <div className="provider-model-row__capabilities">
              {model.reasoning ? <span title={`${model.availableThinkingLevels.length} reasoning levels`}><Gauge size={11} /> Reasoning</span> : null}
              {model.fastModeSupported ? <span><Zap size={11} /> Fast</span> : null}
              <span className={model.available && model.enabled !== false ? 'is-available' : ''}>{model.enabled === false ? (externalAuth ? '已隐藏' : '已停用') : externalAuth ? '已显示' : model.available ? '可用' : '需要凭据'}</span>
            </div>
            <label className="provider-row__toggle provider-model-row__toggle" title={model.enabled === false ? `在 ${agentName} 中显示模型` : `在 ${agentName} 中隐藏模型`}><input type="checkbox" aria-label={`显示模型 ${model.name}`} checked={model.enabled !== false} disabled={busyProvider === `model:${model.key}`} onChange={(event) => void run(`model:${model.key}`, () => onSetModelEnabled(model.key, event.target.checked))} /><i aria-hidden="true"><span /></i></label>
          </div>)}</div>
        </div>})}
      </div>}
      {catalog && view === 'providers' && !providers.length ? <p className="settings-empty">没有匹配的服务商。</p> : null}
      {catalog && view === 'models' && !modelGroups.length ? <p className="settings-empty">没有匹配的模型。</p> : null}
      {apiKeyProvider ? <Modal title={`连接 ${apiKeyProvider.name}`} onClose={() => { if (!busyProvider) closeApiKey() }} footer={<><button type="button" className="button" disabled={Boolean(busyProvider)} onClick={closeApiKey}>取消</button><button type="button" className="button button--primary" disabled={Boolean(busyProvider) || !apiKey.trim()} onClick={() => void saveApiKey()}>保存 API 密钥</button></>}><p className="modal-intro">密钥保存在此桌面当前助手的私有配置中。</p>{apiKeyError ? <p className="settings-error" role="alert">{apiKeyError}</p> : null}<label className="field"><span>API 密钥</span><input autoFocus type="password" value={apiKey} autoComplete="off" spellCheck={false} onChange={(event) => setApiKey(event.target.value)} /></label></Modal> : null}
    </section>
  )
}

/** The Providers settings page: heading plus the provider/model catalog section. */
export function ProvidersSettings(props: ProviderSettingsProps) {
  return (
    <>
      <header><h1>服务商</h1></header>
      <ProviderSettings {...props} />
    </>
  )
}
