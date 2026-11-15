import { z } from 'zod'
import { aiAgents, WORKFLOW_DRAFT_PROVIDER_OPTIONS } from '../ai-agents'
import { WORKFLOW_DRAFT_AGENT_ID, workflowDraftGenerationSchema } from '../lib/ai-authoring'

type JsonSchemaNode = { properties?: Record<string, unknown>; required?: string[] }

describe('workflows.workflow_author agent', () => {
  const agent = aiAgents.find((entry) => entry.id === WORKFLOW_DRAFT_AGENT_ID)

  it('disables OpenAI strict JSON schema for the draft output', () => {
    expect(agent).toBeDefined()
    expect(agent?.modelSettings?.providerOptions).toEqual(WORKFLOW_DRAFT_PROVIDER_OPTIONS)
    expect(WORKFLOW_DRAFT_PROVIDER_OPTIONS).toEqual({ openai: { strictJsonSchema: false } })
  })

  it('declares optional keys, which is why the draft must keep strictJsonSchema disabled', () => {
    const jsonSchema = z.toJSONSchema(workflowDraftGenerationSchema) as JsonSchemaNode
    const propertyNames = Object.keys(jsonSchema.properties ?? {})
    const required = jsonSchema.required ?? []
    expect(propertyNames).toContain('contextSchema')
    expect(required).not.toContain('contextSchema')
  })
})
