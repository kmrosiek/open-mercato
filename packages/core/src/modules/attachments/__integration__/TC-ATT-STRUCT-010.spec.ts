import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import {
  deleteAttachmentIfExists,
  uploadAttachmentFixture,
} from '@open-mercato/core/modules/core/__integration__/helpers/attachmentsFixtures'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/modules/core/__integration__/helpers/authFixtures'
import { getTokenScope, readJsonSafe } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures'
import {
  PAST_PERFORMANCE_PHRASE,
  buildRulebookPdf,
  deletePartitionQuietly,
  extractAndWait,
  prepareStructurePartition,
  readSections,
  readStructure,
  type StructurePartition,
} from './helpers/documentStructure'

export const integrationMeta = {
  dependsOnModules: ['attachments', 'documents', 'ai_assistant'],
}

/**
 * TC-ATT-STRUCT-010: document-section text follows attachment owner access
 * Source: PR #9648 item B-15 (document-section text bypassed attachment owner access).
 * Surfaces: GET /api/attachments/structure/:id, GET /api/attachments/structure/:id/sections
 * (also behind the cited-section page), POST /api/ai_assistant/tools/execute with
 * `attachments.get_document_sections`, and GET /api/attachments/file/:id as the baseline.
 *
 * For an attachment owned by a `documents:document`, a same-organization user holding
 * attachments.view but no access to the document gets 404 from the file route. Before
 * B-15 the same user read the full section text from the structure API and the tool.
 */

const TEST_TIMEOUT_MS = 300_000
const VALID_PASSWORD = 'Valid1!Pass'
const READER_FEATURES = ['ai_assistant.view', 'attachments.view']

type ToolRead = { status: number; toolStatus: string | null; contents: string[] }

async function executeSectionsTool(
  request: APIRequestContext,
  token: string,
  attachmentId: string,
): Promise<ToolRead> {
  const response = await apiRequest(request, 'POST', '/api/ai_assistant/tools/execute', {
    token,
    data: { toolName: 'attachments.get_document_sections', args: { attachmentId, numberLabel: '8.12' } },
  })
  const body = (await readJsonSafe<{ result?: { status?: string; items?: Array<{ content?: string }> } }>(response)) ?? {}
  const items = Array.isArray(body.result?.items) ? body.result!.items! : []
  return {
    status: response.status(),
    toolStatus: typeof body.result?.status === 'string' ? body.result.status : null,
    contents: items.map((item) => item.content ?? ''),
  }
}

async function createOwnerDocument(request: APIRequestContext, token: string, title: string): Promise<string | null> {
  const response = await apiRequest(request, 'POST', '/api/documents', { token, data: { title, folderId: null } })
  if (response.status() === 404) return null
  expect(response.status(), 'POST /api/documents should return 201').toBe(201)
  const body = await readJsonSafe<{ id?: string }>(response)
  expect(typeof body?.id, 'document id').toBe('string')
  return body!.id!
}

async function fileStatus(request: APIRequestContext, token: string, attachmentId: string): Promise<number> {
  const response = await apiRequest(request, 'GET', `/api/attachments/file/${encodeURIComponent(attachmentId)}`, { token })
  return response.status()
}

test.describe('TC-ATT-STRUCT-010: document sections and attachment owner access', () => {
  test('hide the sections of an owner-protected attachment from a reader who cannot open the file, and keep them for the owner', async ({ request }) => {
    test.setTimeout(TEST_TIMEOUT_MS)
    const adminToken = await getAuthToken(request, 'admin')
    const superadminToken = await getAuthToken(request, 'superadmin')
    const { tenantId, organizationId } = getTokenScope(adminToken)
    const stamp = `tc-att-struct-010-${Date.now()}`

    let partition: StructurePartition | null = null
    let attachmentId: string | null = null
    let documentId: string | null = null
    let roleId: string | null = null
    let userId: string | null = null

    try {
      documentId = await createOwnerDocument(request, adminToken, `${stamp}-owner`)
      test.skip(!documentId, 'documents module unavailable')

      partition = await prepareStructurePartition(request, adminToken, 'owner_access')
      const owned = await uploadAttachmentFixture(request, adminToken, {
        entityId: 'documents:document',
        recordId: documentId!,
        fileName: `${stamp}-owned.pdf`,
        mimeType: 'application/pdf',
        buffer: await buildRulebookPdf(),
        partitionCode: partition.partitionCode,
      })
      attachmentId = owned.id
      const structure = await extractAndWait(request, adminToken, attachmentId, partition)
      test.skip(
        structure.extraction?.status !== 'completed',
        `document structure extraction is not supported here (status ${structure.extraction?.status ?? 'none'})`,
      )

      expect(await fileStatus(request, adminToken, attachmentId), 'owner: file route').toBe(200)
      const ownerSections = await readSections(request, adminToken, attachmentId, '?numberLabel=8.12')
      expect(ownerSections.status, 'owner: GET sections').toBe(200)
      expect(ownerSections.body?.items?.[0]?.text ?? '', 'owner: clause 8.12 text').toContain(PAST_PERFORMANCE_PHRASE)
      const ownerTool = await executeSectionsTool(request, adminToken, attachmentId)
      expect(ownerTool.status, 'owner: tool execute').toBe(200)
      expect(ownerTool.toolStatus, 'owner: tool status').toBe('completed')
      expect(ownerTool.contents.join('\n'), 'owner: tool content').toContain(PAST_PERFORMANCE_PHRASE)

      roleId = await createRoleFixture(request, superadminToken, { tenantId, name: `QA Section Reader ${stamp}` })
      await setRoleAclFeatures(request, superadminToken, { roleId, features: READER_FEATURES, organizations: [organizationId] })
      const email = `${stamp}-reader@test.invalid`
      userId = await createUserFixture(request, superadminToken, {
        email,
        password: VALID_PASSWORD,
        organizationId,
        roles: [roleId],
        name: `QA Section Reader ${stamp}`,
      })
      const readerToken = await getAuthToken(request, email, VALID_PASSWORD)

      expect(await fileStatus(request, readerToken, attachmentId), 'reader: file route baseline').toBe(404)
      const readerSections = await readSections(request, readerToken, attachmentId, '?numberLabel=8.12')
      expect(readerSections.status, 'reader: GET sections').toBe(404)
      expect(JSON.stringify(readerSections.body ?? {}), 'reader: no section text').not.toContain(PAST_PERFORMANCE_PHRASE)
      const readerStructure = await readStructure(request, readerToken, attachmentId)
      expect(readerStructure.status, 'reader: GET structure').toBe(404)
      const readerTool = await executeSectionsTool(request, readerToken, attachmentId)
      expect(readerTool.status, 'reader: tool execute keeps the 200 contract').toBe(200)
      expect(readerTool.toolStatus, 'reader: tool status').toBe('not_found')
      expect(readerTool.contents, 'reader: no tool content').toEqual([])
    } finally {
      await deleteAttachmentIfExists(request, adminToken, attachmentId)
      if (documentId) {
        await apiRequest(request, 'DELETE', `/api/documents/${documentId}`, { token: adminToken }).catch(() => undefined)
      }
      await deletePartitionQuietly(request, adminToken, partition)
      await deleteUserIfExists(request, superadminToken, userId)
      await deleteRoleIfExists(request, superadminToken, roleId)
    }
  })
})
