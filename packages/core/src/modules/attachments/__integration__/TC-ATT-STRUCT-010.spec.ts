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
  STRUCTURE_TEST_TIMEOUT_MS,
  buildRulebookPdf,
  deletePartitionQuietly,
  extractAndWait,
  prepareStructurePartition,
  readSections,
  readStructure,
  uploadStructureDocument,
  type StructurePartition,
} from './helpers/documentStructure'

export const integrationMeta = {
  dependsOnModules: ['attachments', 'documents', 'ai_assistant'],
}

/**
 * TC-ATT-STRUCT-010: document-section text honors attachment owner access
 * Source: PR #9648 item B-15; spec .ai/specs/2026-10-21-document-structure-extraction.md
 * Surfaces: GET /api/attachments/structure/:id, GET /api/attachments/structure/:id/sections,
 * POST /api/ai_assistant/tools/execute with `attachments.get_document_sections`,
 * GET /api/attachments/file/:id as the baseline.
 *
 * A same-organization reader holding attachments.view must not read the sections of an
 * attachment owned by a `documents:document` it cannot open: the structure API answers 404
 * and the tool answers `not_found`, exactly like the file route. The document owner still
 * reads them, and the reader still reads sections of an unprotected library attachment.
 */

const PASSWORD = 'Valid1!Pass'
const READER_FEATURES = ['attachments.view', 'ai_assistant.view']

type ToolRead = { status: number; toolStatus: string | null; contents: string[] }

async function executeSectionsTool(
  request: APIRequestContext,
  token: string,
  attachmentId: string,
): Promise<ToolRead> {
  const response = await apiRequest(request, 'POST', '/api/ai_assistant/tools/execute', {
    token,
    data: {
      toolName: 'attachments.get_document_sections',
      args: { attachmentId, numberLabel: '8.12', includeText: true },
    },
  })
  const body = (await readJsonSafe<{ result?: { status?: string; items?: Array<{ content?: string }> } }>(response)) ?? {}
  const items = Array.isArray(body.result?.items) ? body.result!.items! : []
  return {
    status: response.status(),
    toolStatus: typeof body.result?.status === 'string' ? body.result.status : null,
    contents: items.map((item) => item.content ?? ''),
  }
}

async function createOwnerDocument(request: APIRequestContext, token: string, title: string): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/documents', { token, data: { title, folderId: null } })
  expect(response.status(), 'POST /api/documents should return 201').toBe(201)
  const body = await readJsonSafe<{ id?: string }>(response)
  expect(typeof body?.id, 'document id').toBe('string')
  return body!.id!
}

test.describe('TC-ATT-STRUCT-010: document sections and attachment owner access', () => {
  test('hide owner-protected section text from an attachments.view reader and keep it for the owner', async ({ request }) => {
    test.setTimeout(STRUCTURE_TEST_TIMEOUT_MS * 2)
    const adminToken = await getAuthToken(request, 'admin')
    const superadminToken = await getAuthToken(request, 'superadmin')
    const { tenantId, organizationId } = getTokenScope(adminToken)
    const stamp = `tc-att-struct-010-${Date.now()}`

    let partition: StructurePartition | null = null
    let libraryAttachmentId: string | null = null
    let ownedAttachmentId: string | null = null
    let ownerDocumentId: string | null = null
    let readerRoleId: string | null = null
    let readerUserId: string | null = null

    try {
      partition = await prepareStructurePartition(request, adminToken, 'owner_access')
      const pdf = await buildRulebookPdf()

      libraryAttachmentId = await uploadStructureDocument(request, adminToken, partition, {
        fileName: `${stamp}-library.pdf`,
        mimeType: 'application/pdf',
        buffer: pdf,
      })
      const libraryStructure = await extractAndWait(request, adminToken, libraryAttachmentId, partition)
      expect(libraryStructure.extraction?.status, 'library extraction should complete').toBe('completed')

      ownerDocumentId = await createOwnerDocument(request, adminToken, `${stamp}-owner`)
      const owned = await uploadAttachmentFixture(request, adminToken, {
        entityId: 'documents:document',
        recordId: ownerDocumentId,
        fileName: `${stamp}-owned.pdf`,
        mimeType: 'application/pdf',
        buffer: pdf,
        partitionCode: partition.partitionCode,
      })
      ownedAttachmentId = owned.id
      const ownedStructure = await extractAndWait(request, adminToken, ownedAttachmentId, partition)
      expect(ownedStructure.extraction?.status, 'owned document extraction should complete').toBe('completed')

      readerRoleId = await createRoleFixture(request, superadminToken, { tenantId, name: `QA Section Reader ${stamp}` })
      await setRoleAclFeatures(request, superadminToken, {
        roleId: readerRoleId,
        features: READER_FEATURES,
        organizations: [organizationId],
      })
      const readerEmail = `${stamp}-reader@test.invalid`
      readerUserId = await createUserFixture(request, superadminToken, {
        email: readerEmail,
        password: PASSWORD,
        organizationId,
        roles: [readerRoleId],
        name: `QA Section Reader ${stamp}`,
      })
      const readerToken = await getAuthToken(request, readerEmail, PASSWORD)

      const ownerSections = await readSections(request, adminToken, ownedAttachmentId, '?numberLabel=8.12')
      expect(ownerSections.status, 'the owner reads the owned sections').toBe(200)
      expect(ownerSections.body?.items[0]?.text ?? '').toContain(PAST_PERFORMANCE_PHRASE)
      const ownerTool = await executeSectionsTool(request, adminToken, ownedAttachmentId)
      expect(ownerTool.status, 'tools/execute should return 200 for the owner').toBe(200)
      expect(ownerTool.toolStatus, 'the owner tool call reads the extraction').toBe('completed')
      expect(ownerTool.contents.join('\n')).toContain(PAST_PERFORMANCE_PHRASE)

      const readerLibrary = await readSections(request, readerToken, libraryAttachmentId, '?numberLabel=8.12')
      expect(readerLibrary.status, 'the reader still reads an unprotected attachment').toBe(200)
      expect(readerLibrary.body?.items[0]?.text ?? '').toContain(PAST_PERFORMANCE_PHRASE)
      const readerLibraryTool = await executeSectionsTool(request, readerToken, libraryAttachmentId)
      expect(readerLibraryTool.toolStatus, 'the reader tool call reads an unprotected attachment').toBe('completed')

      const readerFile = await apiRequest(request, 'GET', `/api/attachments/file/${ownedAttachmentId}`, { token: readerToken })
      expect(readerFile.status(), 'baseline: the file route hides the owned file from the reader').toBe(404)

      const readerSections = await readSections(request, readerToken, ownedAttachmentId, '?numberLabel=8.12')
      expect(readerSections.status, 'the sections API hides owner-protected text').toBe(404)
      expect(JSON.stringify(readerSections.body ?? {})).not.toContain(PAST_PERFORMANCE_PHRASE)
      const readerStructure = await readStructure(request, readerToken, ownedAttachmentId)
      expect(readerStructure.status, 'the structure API hides the owner-protected outline').toBe(404)

      const readerTool = await executeSectionsTool(request, readerToken, ownedAttachmentId)
      expect(readerTool.status, 'tools/execute keeps the 200 contract').toBe(200)
      expect(readerTool.toolStatus, 'the tool reports not_found for owner-protected text').toBe('not_found')
      expect(readerTool.contents).toEqual([])
    } finally {
      await deleteAttachmentIfExists(request, adminToken, libraryAttachmentId)
      await deleteAttachmentIfExists(request, adminToken, ownedAttachmentId)
      if (ownerDocumentId) {
        await apiRequest(request, 'DELETE', `/api/documents/${ownerDocumentId}`, { token: adminToken }).catch(() => undefined)
      }
      await deletePartitionQuietly(request, adminToken, partition)
      await deleteUserIfExists(request, superadminToken, readerUserId)
      await deleteRoleIfExists(request, superadminToken, readerRoleId)
    }
  })
})
