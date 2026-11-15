import { AiModelFactoryError } from './model-factory'

export type ModelUnavailableCode = 'no_provider_configured' | 'api_key_missing' | 'provider_rejected'

const MODEL_FACTORY_ERROR_CODES = new Set<ModelUnavailableCode>(['no_provider_configured', 'api_key_missing'])

const PROVIDER_REFUSAL_STATUSES = new Set([401, 402, 403, 429])

const BILLING_REFUSAL = /credit balance|billing|insufficient[_ ]quota|payment required/i

function asModelFactoryCode(err: unknown): ModelUnavailableCode | null {
  if (err instanceof AiModelFactoryError) {
    return MODEL_FACTORY_ERROR_CODES.has(err.code as ModelUnavailableCode)
      ? (err.code as ModelUnavailableCode)
      : 'no_provider_configured'
  }
  if (!err || typeof err !== 'object') return null
  const candidate = err as { name?: unknown; code?: unknown }
  if (candidate.name !== 'AiModelFactoryError') return null
  return typeof candidate.code === 'string' && MODEL_FACTORY_ERROR_CODES.has(candidate.code as ModelUnavailableCode)
    ? (candidate.code as ModelUnavailableCode)
    : 'no_provider_configured'
}

function isProviderRefusal(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const candidate = err as { name?: unknown; statusCode?: unknown; responseBody?: unknown }
  if (candidate.name !== 'AI_APICallError') return false
  const status = typeof candidate.statusCode === 'number' ? candidate.statusCode : null
  if (status !== null && PROVIDER_REFUSAL_STATUSES.has(status)) return true
  const body = typeof candidate.responseBody === 'string' ? candidate.responseBody : ''
  return status === 400 && BILLING_REFUSAL.test(body)
}

/**
 * Classifies an error as "this deployment cannot run a model" — no provider,
 * a provider without a key, or a provider refusing the call for an
 * auth/billing/quota reason. Matched structurally (name + code / status) because
 * the error may cross a module or queue boundary that drops its prototype.
 *
 * A plain provider 400 is deliberately NOT classified: that is where a malformed
 * request from our own code (e.g. a schema the provider rejects) lands, and
 * reporting it as an environment problem would hide a real defect.
 */
export function classifyModelUnavailableError(err: unknown): ModelUnavailableCode | null {
  const factoryCode = asModelFactoryCode(err)
  if (factoryCode) return factoryCode
  if (isProviderRefusal(err)) return 'provider_rejected'
  return null
}
