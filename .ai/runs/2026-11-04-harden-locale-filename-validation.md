# Execution plan — harden locale checker dictionary filename validation

Source issue: `open-mercato/open-mercato#8436` (read-only upstream; work lands on the fork `kmrosiek/open-mercato`).

## Goal

App dictionary filenames only enter the translation checkers' target locale sets when they name a locale the runtime could register: a locale declared in `packages/shared/src/lib/i18n/config.ts`, or a code whose base subtag is in the ISO 639-1 table `packages/shared/src/lib/i18n/iso639.ts` — the same rule `registerLocales` applies.

## Scope

- `scripts/lib/i18n-locale-set.mjs` — ISO 639-1 table reader, locale-code matcher, filename filtering, config-parser hardening.
- `scripts/__tests__/i18n-locale-set.test.mjs`, `scripts/__tests__/i18n-check-values-scopes.test.mjs` — regressions.

## Non-goals

- No change to the runtime locale registry, to `iso639.ts`, or to the checker CLIs' output format.
- No support for ISO 639-3-only codes beyond what `registerLocales` accepts (declare them in `config.ts`).

## Implementation Plan

### Phase 1: Filename validation and parser hardening
- Parse `iso639.ts` as text (fail closed on an empty or malformed table).
- Filter app locale files through a matcher: declared config locale OR ISO 639-1 base subtag. Unnormalized-name errors only fire for names that would be recognised locales.
- Config parser: ignore comments, reject duplicate `locales`/`defaultLocale` declarations, require normalized locale codes.
- Regression tests: unrelated JSON (`faq.json`, `app.json`), extra locales, regional variants, declared non-ISO locale, parser hardening, CLI-level values-checker case.

## Risks

- A genuine locale that is neither ISO 639-1 nor declared in `config.ts` is now ignored by the checkers. Mitigation: identical to the runtime rule, so such a locale could not be served anyway.

## Progress

PR: #3

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Filename validation and parser hardening

- [x] 1.1 Validate app dictionary filenames against ISO 639-1 and declared locales — 054f2e14a8
- [x] 1.2 Harden the platform config parser — 054f2e14a8
- [x] 1.3 Regression tests for filenames, regional variants and config parsing — 054f2e14a8
