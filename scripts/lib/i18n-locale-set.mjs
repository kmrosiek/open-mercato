import fs from 'node:fs'
import path from 'node:path'

export const PLATFORM_LOCALE_CONFIG_PATH = path.join('packages', 'shared', 'src', 'lib', 'i18n', 'config.ts')
export const ISO_639_1_TABLE_PATH = path.join('packages', 'shared', 'src', 'lib', 'i18n', 'iso639.ts')

const LOCALE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/
const LOCALE_FILE_PATTERN = /^([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\.json$/
const LOCALE_SHAPED_FILE_PATTERN = /^([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*)\.json$/
const STRING_LITERAL_PATTERN = /^(?:'([^'\\]+)'|"([^"\\]+)")$/
const ISO_639_1_ENTRY_PATTERN = /\{\s*code:\s*(?:'([^']*)'|"([^"]*)")/g
const ISO_639_1_CODE_PATTERN = /^[a-z]{2}$/

function stripComments(source) {
  let output = ''
  let quote = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      output += char
      if (char === '\\') {
        output += source[index + 1] ?? ''
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      output += char
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      output += '\n'
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      const comment = source.slice(index, end === -1 ? source.length : end + 2)
      output += comment.replace(/[^\n]/g, ' ')
      index = end === -1 ? source.length : end + 1
      continue
    }
    output += char
  }
  return output
}

function findSingleDeclaration(source, variableName, valuePattern) {
  const declarations = [...source.matchAll(new RegExp(`export\\s+const\\s+${variableName}\\b`, 'g'))]
  if (declarations.length > 1) {
    throw new Error(`The platform i18n config declares \`${variableName}\` more than once`)
  }
  return source.match(new RegExp(`export\\s+const\\s+${variableName}\\s*(?::[^=]+)?=\\s*${valuePattern}`))
}

function parseStringArrayLiteral(source, variableName) {
  const match = findSingleDeclaration(source, variableName, '\\[([^\\]]*)\\]')
  if (!match) return null
  const members = match[1].split(',').map((member) => member.trim())
  if (members.length > 0 && members[members.length - 1] === '') members.pop()
  const values = members.map((member) => member.match(STRING_LITERAL_PATTERN))
  if (values.length === 0 || values.some((literal) => !literal)) {
    throw new Error(`The \`${variableName}\` literal in the platform i18n config must contain only string literals`)
  }
  const locales = values.map((literal) => literal[1] ?? literal[2])
  if (new Set(locales).size !== locales.length) {
    throw new Error(`The \`${variableName}\` literal in the platform i18n config contains duplicate entries`)
  }
  return locales
}

function parseStringLiteral(source, variableName) {
  const match = findSingleDeclaration(source, variableName, `(?:'([^']+)'|"([^"]+)")`)
  return match ? (match[1] ?? match[2]) : null
}

export function parseLocaleConfigSource(rawSource) {
  const source = stripComments(rawSource)
  const locales = parseStringArrayLiteral(source, 'locales')
  const defaultLocale = parseStringLiteral(source, 'defaultLocale')
  if (!locales || locales.length === 0) {
    throw new Error('Could not read the `locales` literal from the platform i18n config')
  }
  const unnormalized = locales.filter((locale) => !LOCALE_CODE_PATTERN.test(locale))
  if (unnormalized.length > 0) {
    throw new Error(`The \`locales\` literal in the platform i18n config must use normalized lowercase, hyphenated codes: ${unnormalized.join(', ')}`)
  }
  if (!defaultLocale || !locales.includes(defaultLocale)) {
    throw new Error('Could not read a `defaultLocale` literal that is one of `locales` from the platform i18n config')
  }
  return { locales, defaultLocale }
}

export function readPlatformLocaleSet(root) {
  const configPath = path.join(root, PLATFORM_LOCALE_CONFIG_PATH)
  const source = fs.readFileSync(configPath, 'utf-8')
  return parseLocaleConfigSource(source)
}

export function parseIso639TableSource(source) {
  const entries = [...source.matchAll(ISO_639_1_ENTRY_PATTERN)].map((match) => match[1] ?? match[2])
  if (entries.length === 0) {
    throw new Error('Could not read any ISO 639-1 entries from the platform i18n ISO table')
  }
  const malformed = entries.filter((code) => !ISO_639_1_CODE_PATTERN.test(code))
  if (malformed.length > 0) {
    throw new Error(`The platform i18n ISO table contains codes that are not ISO 639-1: ${malformed.join(', ')}`)
  }
  return new Set(entries)
}

export function readIso639Codes(root) {
  const tablePath = path.join(root, ISO_639_1_TABLE_PATH)
  return parseIso639TableSource(fs.readFileSync(tablePath, 'utf-8'))
}

export function createLocaleCodeMatcher({ declaredLocales, iso639Codes }) {
  const declared = new Set(declaredLocales)
  return (code) => declared.has(code) || iso639Codes.has(code.split('-')[0])
}

export function resolveAppRoot(root, filePath) {
  const segments = path.relative(root, filePath).split(/[\\/]/)
  if (segments.length < 2 || segments[0] !== 'apps') return null
  return path.join(root, segments[0], segments[1])
}

export function readAppLocaleSet(appRoot, isLocaleCode) {
  const i18nDir = path.join(appRoot, 'src', 'i18n')
  if (!fs.existsSync(i18nDir)) return null
  const fileNames = fs
    .readdirSync(i18nDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  const normalizedCodeOf = (name) => name.match(LOCALE_SHAPED_FILE_PATTERN)?.[1].toLowerCase().replace(/_/g, '-')
  const unnormalized = fileNames.filter((name) => {
    const code = normalizedCodeOf(name)
    return Boolean(code) && !LOCALE_FILE_PATTERN.test(name) && isLocaleCode(code)
  })
  if (unnormalized.length > 0) {
    const renames = unnormalized.map((name) => `${name} -> ${name.toLowerCase().replace(/_/g, '-')}`).join(', ')
    throw new Error(`Locale files in ${i18nDir} must use normalized lowercase, hyphenated codes: ${renames}`)
  }
  const locales = fileNames
    .map((name) => name.match(LOCALE_FILE_PATTERN)?.[1])
    .filter((locale) => Boolean(locale) && isLocaleCode(locale))
  return locales.length > 0 ? locales : null
}

function orderLocales(locales, platformLocales) {
  const platformOrder = new Map(platformLocales.map((locale, index) => [locale, index]))
  return [...locales].sort((left, right) => {
    const leftIndex = platformOrder.get(left) ?? Number.POSITIVE_INFINITY
    const rightIndex = platformOrder.get(right) ?? Number.POSITIVE_INFINITY
    if (leftIndex !== rightIndex) return leftIndex - rightIndex
    return left < right ? -1 : left > right ? 1 : 0
  })
}

export function createTargetLocaleResolver({
  root,
  referenceLocale,
  platform = readPlatformLocaleSet(root),
  iso639Codes = readIso639Codes(root),
}) {
  const appLocaleCache = new Map()
  const isLocaleCode = createLocaleCodeMatcher({ declaredLocales: platform.locales, iso639Codes })

  const describeScope = (enJsonPath) => {
    const appRoot = resolveAppRoot(root, enJsonPath)
    if (!appRoot) return { scope: 'platform', locales: platform.locales }
    if (!appLocaleCache.has(appRoot)) appLocaleCache.set(appRoot, readAppLocaleSet(appRoot, isLocaleCode))
    const appLocales = appLocaleCache.get(appRoot)
    if (!appLocales) return { scope: 'platform', locales: platform.locales }
    return { scope: path.relative(root, appRoot).split(path.sep).join('/'), locales: orderLocales(appLocales, platform.locales) }
  }

  return {
    platform,
    describeScope,
    targetsFor(enJsonPath) {
      return describeScope(enJsonPath).locales.filter((locale) => locale !== referenceLocale)
    },
  }
}
