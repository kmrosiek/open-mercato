import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createLocaleCodeMatcher,
  createTargetLocaleResolver,
  parseIso639TableSource,
  parseLocaleConfigSource,
  readAppLocaleSet,
  readIso639Codes,
  readPlatformLocaleSet,
  resolveAppRoot,
} from '../lib/i18n-locale-set.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const CONFIG_SOURCE = `
/**
 * Mentions locales and defaultLocale in prose, and \`Record<Locale, T>\`.
 */
export interface LocaleRegistry { en: true; pl: true; es: true; de: true; ko: true }
export type Locale = keyof LocaleRegistry & string
export const locales: Locale[] = ['en', 'pl', 'es', 'de', 'ko']
export const defaultLocale: Locale = 'en'
`

const ISO_SOURCE = `
export const ISO_639_1: ReadonlyArray<{ code: string; label: string }> = [
${['cs', 'de', 'en', 'es', 'ko', 'pl', 'pt', 'st', 'xh', 'zh', 'zu'].map((code) => `  { code: '${code}', label: '${code}' },`).join('\n')}
] as const
`

const PLATFORM_FILES = {
  'packages/shared/src/lib/i18n/config.ts': CONFIG_SOURCE,
  'packages/shared/src/lib/i18n/iso639.ts': ISO_SOURCE,
}

const isLocaleCode = createLocaleCodeMatcher({
  declaredLocales: ['en', 'pl', 'es', 'de', 'ko'],
  iso639Codes: parseIso639TableSource(ISO_SOURCE),
})

const createdRoots = []

test.after(() => {
  for (const root of createdRoots) fs.rmSync(root, { recursive: true, force: true })
})

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-locale-set-'))
  createdRoots.push(root)
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, contents)
  }
  return root
}

test('parseLocaleConfigSource reads the locales and defaultLocale literals', () => {
  assert.deepEqual(parseLocaleConfigSource(CONFIG_SOURCE), {
    locales: ['en', 'pl', 'es', 'de', 'ko'],
    defaultLocale: 'en',
  })
})

test('parseLocaleConfigSource accepts double quotes and no type annotation', () => {
  const source = `export const locales = ["en", "cs"]\nexport const defaultLocale = "en"\n`
  assert.deepEqual(parseLocaleConfigSource(source), { locales: ['en', 'cs'], defaultLocale: 'en' })
})

test('parseLocaleConfigSource fails closed when the literals are missing or inconsistent', () => {
  assert.throws(() => parseLocaleConfigSource('export const defaultLocale = "en"'), /locales/)
  assert.throws(() => parseLocaleConfigSource("export const locales = ['en']"), /defaultLocale/)
  assert.throws(
    () => parseLocaleConfigSource("export const locales = ['pl']\nexport const defaultLocale = 'en'"),
    /defaultLocale/,
  )
})

test('parseLocaleConfigSource accepts a multi-line array with a trailing comma', () => {
  const source = "export const locales: Locale[] = [\n  'en',\n  'pl',\n]\nexport const defaultLocale: Locale = 'en'\n"
  assert.deepEqual(parseLocaleConfigSource(source), { locales: ['en', 'pl'], defaultLocale: 'en' })
})

test('parseLocaleConfigSource rejects a partially readable locales array instead of dropping members', () => {
  const withDefault = (array) => `export const locales = ${array}\nexport const defaultLocale = 'en'\n`
  assert.throws(() => parseLocaleConfigSource(withDefault("['en', ...extraLocales]")), /only string literals/)
  assert.throws(() => parseLocaleConfigSource(withDefault("['en', EXTRA_LOCALE]")), /only string literals/)
  assert.throws(() => parseLocaleConfigSource(withDefault("['en', , 'pl']")), /only string literals/)
  assert.throws(() => parseLocaleConfigSource(withDefault('[]')), /only string literals/)
  assert.throws(() => parseLocaleConfigSource(withDefault("['en', 'pl', 'en']")), /duplicate/)
})

test('parseLocaleConfigSource ignores declarations inside comments', () => {
  const source = [
    '/**',
    " * export const locales = ['xx']",
    " * export const defaultLocale = 'xx'",
    ' */',
    "// export const locales = ['yy']",
    "export const locales = ['en', 'pl'] // export const locales = ['zz']",
    "export const defaultLocale = 'en'",
  ].join('\n')
  assert.deepEqual(parseLocaleConfigSource(source), { locales: ['en', 'pl'], defaultLocale: 'en' })
})

test('parseLocaleConfigSource keeps string contents that look like comments', () => {
  const source = "export const note = 'see https://example.com /* not a comment */'\nexport const locales = ['en']\nexport const defaultLocale = 'en'\n"
  assert.deepEqual(parseLocaleConfigSource(source), { locales: ['en'], defaultLocale: 'en' })
})

test('parseLocaleConfigSource rejects duplicate declarations instead of reading the first one', () => {
  assert.throws(
    () => parseLocaleConfigSource("export const locales = ['en']\nexport const locales = ['en', 'pl']\nexport const defaultLocale = 'en'"),
    /`locales` more than once/,
  )
  assert.throws(
    () => parseLocaleConfigSource("export const locales = ['en', 'pl']\nexport const defaultLocale = 'en'\nexport const defaultLocale = 'pl'"),
    /`defaultLocale` more than once/,
  )
})

test('parseLocaleConfigSource does not confuse similarly named declarations', () => {
  const source = "export const localesExtra = ['xx']\nexport const locales = ['en', 'pl']\nexport const defaultLocale = 'en'\n"
  assert.deepEqual(parseLocaleConfigSource(source), { locales: ['en', 'pl'], defaultLocale: 'en' })
})

test('parseLocaleConfigSource rejects locale codes that are not normalized', () => {
  const withLocales = (array) => `export const locales = ${array}\nexport const defaultLocale = 'en'\n`
  assert.throws(() => parseLocaleConfigSource(withLocales("['en', 'pt-BR']")), /normalized.*pt-BR/)
  assert.throws(() => parseLocaleConfigSource(withLocales("['en', 'zh_hant']")), /normalized.*zh_hant/)
  assert.throws(() => parseLocaleConfigSource(withLocales("['en', 'faq.json']")), /normalized/)
  assert.deepEqual(parseLocaleConfigSource(withLocales("['en', 'pt-br']")).locales, ['en', 'pt-br'])
})

test('parseIso639TableSource reads the ISO 639-1 codes and fails closed on a bad table', () => {
  assert.deepEqual([...parseIso639TableSource(ISO_SOURCE)].sort(), ['cs', 'de', 'en', 'es', 'ko', 'pl', 'pt', 'st', 'xh', 'zh', 'zu'])
  assert.throws(() => parseIso639TableSource('export const ISO_639_1 = []'), /Could not read/)
  assert.throws(() => parseIso639TableSource("[{ code: 'en' }, { code: 'fil' }, { code: 'PL' }]"), /not ISO 639-1: fil, PL/)
})

test('readIso639Codes parses the real platform ISO table', () => {
  const codes = readIso639Codes(REPO_ROOT)
  for (const code of ['en', 'pl', 'es', 'de', 'ko', 'xh', 'zu', 'pt', 'zh']) assert.ok(codes.has(code), code)
  for (const code of ['faq', 'app', 'zz']) assert.ok(!codes.has(code), code)
})

test('createLocaleCodeMatcher accepts declared locales and ISO 639-1 base codes only', () => {
  const matcher = createLocaleCodeMatcher({ declaredLocales: ['en', 'tlh'], iso639Codes: new Set(['en', 'pt', 'zh']) })
  assert.equal(matcher('en'), true)
  assert.equal(matcher('tlh'), true)
  assert.equal(matcher('pt'), true)
  assert.equal(matcher('pt-br'), true)
  assert.equal(matcher('zh-hant'), true)
  assert.equal(matcher('faq'), false)
  assert.equal(matcher('app'), false)
  assert.equal(matcher('db'), false)
  assert.equal(matcher('tlh-x'), false)
})

test('readPlatformLocaleSet parses the real platform config', () => {
  const platform = readPlatformLocaleSet(REPO_ROOT)
  assert.ok(platform.locales.includes('en'))
  assert.ok(platform.locales.includes(platform.defaultLocale))
})

test('resolveAppRoot only matches files under apps/<app>/', () => {
  const root = path.join(os.tmpdir(), 'repo')
  assert.equal(
    resolveAppRoot(root, path.join(root, 'apps', 'mercato', 'src', 'modules', 'example', 'i18n', 'en.json')),
    path.join(root, 'apps', 'mercato'),
  )
  assert.equal(resolveAppRoot(root, path.join(root, 'apps', 'mercato', 'src', 'i18n', 'en.json')), path.join(root, 'apps', 'mercato'))
  assert.equal(resolveAppRoot(root, path.join(root, 'packages', 'core', 'src', 'modules', 'auth', 'i18n', 'en.json')), null)
  assert.equal(resolveAppRoot(root, path.join(root, 'external', 'official-modules', 'packages', 'x', 'i18n', 'en.json')), null)
  assert.equal(resolveAppRoot(root, path.join(root, 'apps')), null)
})

test('readAppLocaleSet lists locale files and ignores everything else', () => {
  const root = makeRepo({
    'apps/app/src/i18n/en.json': '{}',
    'apps/app/src/i18n/xh.json': '{}',
    'apps/app/src/i18n/pt-br.json': '{}',
    'apps/app/src/i18n/.hardcoded-allowlist.json': '{}',
    'apps/app/src/i18n/README.md': '',
    'apps/app/src/i18n/nested/zu.json': '{}',
  })
  assert.deepEqual(readAppLocaleSet(path.join(root, 'apps', 'app'), isLocaleCode).sort(), ['en', 'pt-br', 'xh'])
})

test('readAppLocaleSet ignores unrelated short-name JSON files', () => {
  const root = makeRepo({
    'apps/app/src/i18n/en.json': '{}',
    'apps/app/src/i18n/pl.json': '{}',
    'apps/app/src/i18n/faq.json': '{}',
    'apps/app/src/i18n/app.json': '{}',
    'apps/app/src/i18n/db.json': '{}',
    'apps/app/src/i18n/api-v2.json': '{}',
    'apps/app/src/i18n/FAQ.json': '{}',
    'apps/app/src/i18n/App_Config.json': '{}',
  })
  assert.deepEqual(readAppLocaleSet(path.join(root, 'apps', 'app'), isLocaleCode).sort(), ['en', 'pl'])
})

test('readAppLocaleSet returns null when only unrelated JSON files are present', () => {
  const root = makeRepo({ 'apps/app/src/i18n/faq.json': '{}', 'apps/app/src/i18n/app.json': '{}' })
  assert.equal(readAppLocaleSet(path.join(root, 'apps', 'app'), isLocaleCode), null)
})

test('readAppLocaleSet keeps genuine extra locales and normalized regional variants', () => {
  const root = makeRepo({
    'apps/app/src/i18n/en.json': '{}',
    'apps/app/src/i18n/cs.json': '{}',
    'apps/app/src/i18n/zu.json': '{}',
    'apps/app/src/i18n/pt-br.json': '{}',
    'apps/app/src/i18n/zh-hant.json': '{}',
  })
  assert.deepEqual(
    readAppLocaleSet(path.join(root, 'apps', 'app'), isLocaleCode).sort(),
    ['cs', 'en', 'pt-br', 'zh-hant', 'zu'],
  )
})

test('readAppLocaleSet accepts a non-ISO locale only when the platform config declares it', () => {
  const root = makeRepo({ 'apps/app/src/i18n/en.json': '{}', 'apps/app/src/i18n/tlh.json': '{}' })
  const appRoot = path.join(root, 'apps', 'app')
  assert.deepEqual(readAppLocaleSet(appRoot, isLocaleCode), ['en'])
  const withDeclared = createLocaleCodeMatcher({ declaredLocales: ['en', 'tlh'], iso639Codes: new Set(['en']) })
  assert.deepEqual(readAppLocaleSet(appRoot, withDeclared).sort(), ['en', 'tlh'])
})

test('readAppLocaleSet fails closed on locale files that are not in normalized form', () => {
  const root = makeRepo({
    'apps/app/src/i18n/en.json': '{}',
    'apps/app/src/i18n/pt-BR.json': '{}',
    'apps/app/src/i18n/zh_Hant.json': '{}',
  })
  assert.throws(
    () => readAppLocaleSet(path.join(root, 'apps', 'app'), isLocaleCode),
    (error) => error.message.includes('pt-BR.json -> pt-br.json') && error.message.includes('zh_Hant.json -> zh-hant.json'),
  )
})

test('readAppLocaleSet returns null when the app has no locale files', () => {
  const root = makeRepo({ 'apps/empty/src/i18n/README.md': '', 'apps/none/package.json': '{}' })
  assert.equal(readAppLocaleSet(path.join(root, 'apps', 'empty'), isLocaleCode), null)
  assert.equal(readAppLocaleSet(path.join(root, 'apps', 'none'), isLocaleCode), null)
})

test('platform modules target the platform set without the reference locale', () => {
  const root = makeRepo(PLATFORM_FILES)
  const resolver = createTargetLocaleResolver({ root, referenceLocale: 'en' })
  const enPath = path.join(root, 'packages', 'core', 'src', 'modules', 'auth', 'i18n', 'en.json')
  assert.deepEqual(resolver.targetsFor(enPath), ['pl', 'es', 'de', 'ko'])
  assert.deepEqual(resolver.describeScope(enPath), { scope: 'platform', locales: ['en', 'pl', 'es', 'de', 'ko'] })
})

test('app modules target the app locale set, so an app can add and drop languages', () => {
  const root = makeRepo({
    ...PLATFORM_FILES,
    'apps/custom/src/i18n/en.json': '{}',
    'apps/custom/src/i18n/zu.json': '{}',
    'apps/custom/src/i18n/xh.json': '{}',
    'apps/custom/src/i18n/st.json': '{}',
  })
  const resolver = createTargetLocaleResolver({ root, referenceLocale: 'en' })
  const moduleEn = path.join(root, 'apps', 'custom', 'src', 'modules', 'records', 'i18n', 'en.json')
  const appEn = path.join(root, 'apps', 'custom', 'src', 'i18n', 'en.json')
  assert.deepEqual(resolver.targetsFor(moduleEn), ['st', 'xh', 'zu'])
  assert.deepEqual(resolver.targetsFor(appEn), ['st', 'xh', 'zu'])
  assert.deepEqual(resolver.describeScope(moduleEn), { scope: 'apps/custom', locales: ['en', 'st', 'xh', 'zu'] })
})

test('app locale sets keep platform order for shared locales and append added ones', () => {
  const root = makeRepo({
    ...PLATFORM_FILES,
    'apps/mixed/src/i18n/ko.json': '{}',
    'apps/mixed/src/i18n/cs.json': '{}',
    'apps/mixed/src/i18n/en.json': '{}',
    'apps/mixed/src/i18n/pl.json': '{}',
  })
  const resolver = createTargetLocaleResolver({ root, referenceLocale: 'en' })
  const enPath = path.join(root, 'apps', 'mixed', 'src', 'modules', 'm', 'i18n', 'en.json')
  assert.deepEqual(resolver.targetsFor(enPath), ['pl', 'ko', 'cs'])
})

test('an app without its own locale files falls back to the platform set', () => {
  const root = makeRepo({ ...PLATFORM_FILES, 'apps/docs/package.json': '{}' })
  const resolver = createTargetLocaleResolver({ root, referenceLocale: 'en' })
  const enPath = path.join(root, 'apps', 'docs', 'src', 'modules', 'm', 'i18n', 'en.json')
  assert.deepEqual(resolver.targetsFor(enPath), ['pl', 'es', 'de', 'ko'])
  assert.equal(resolver.describeScope(enPath).scope, 'platform')
})

test('the resolver fails closed when the platform config cannot be read', () => {
  const root = makeRepo({ 'packages/shared/src/lib/i18n/config.ts': 'export const nothing = 1' })
  assert.throws(() => createTargetLocaleResolver({ root, referenceLocale: 'en' }), /locales/)
  const emptyRoot = makeRepo({})
  assert.throws(() => createTargetLocaleResolver({ root: emptyRoot, referenceLocale: 'en' }), /ENOENT/)
})

test('the resolver fails closed when the ISO table cannot be read', () => {
  const root = makeRepo({ 'packages/shared/src/lib/i18n/config.ts': CONFIG_SOURCE })
  assert.throws(() => createTargetLocaleResolver({ root, referenceLocale: 'en' }), /ENOENT/)
  const emptyTableRoot = makeRepo({ ...PLATFORM_FILES, 'packages/shared/src/lib/i18n/iso639.ts': 'export const ISO_639_1 = []' })
  assert.throws(() => createTargetLocaleResolver({ root: emptyTableRoot, referenceLocale: 'en' }), /ISO 639-1/)
})

test('unrelated JSON files in an app never enter the target locale set', () => {
  const root = makeRepo({
    ...PLATFORM_FILES,
    'apps/custom/src/i18n/en.json': '{}',
    'apps/custom/src/i18n/pl.json': '{}',
    'apps/custom/src/i18n/pt-br.json': '{}',
    'apps/custom/src/i18n/faq.json': '{}',
    'apps/custom/src/i18n/app.json': '{}',
  })
  const resolver = createTargetLocaleResolver({ root, referenceLocale: 'en' })
  const enPath = path.join(root, 'apps', 'custom', 'src', 'modules', 'm', 'i18n', 'en.json')
  assert.deepEqual(resolver.targetsFor(enPath), ['pl', 'pt-br'])
  assert.deepEqual(resolver.describeScope(enPath), { scope: 'apps/custom', locales: ['en', 'pl', 'pt-br'] })
})

test('an app whose only JSON files are unrelated falls back to the platform set', () => {
  const root = makeRepo({ ...PLATFORM_FILES, 'apps/custom/src/i18n/faq.json': '{}' })
  const resolver = createTargetLocaleResolver({ root, referenceLocale: 'en' })
  const enPath = path.join(root, 'apps', 'custom', 'src', 'modules', 'm', 'i18n', 'en.json')
  assert.deepEqual(resolver.targetsFor(enPath), ['pl', 'es', 'de', 'ko'])
})
