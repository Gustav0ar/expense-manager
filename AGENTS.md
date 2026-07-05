# Agent Guidelines

- Write default product UI text, documentation, server messages and tests in English.
- When a user-facing string needs pt-BR support, add the English source string to the UI/server code and add the pt-BR translation in `src/lib/i18n/messages.ts`.
- Do not hardcode pt-BR text outside i18n dictionaries, except for compatibility aliases that intentionally accept external input such as CSV headers.
- When writing pt-BR text for translations, documentation, messages, tests or fixtures, use correct spelling with accents and special characters: `descrição`, `configuração`, `usuários`, `ações`, `permissão`, `código`, `não`, `orçamento`, `relatórios`.
- Preserve unaccented text only when it is a technical identifier, route, database column, environment variable, API key, filename or external compatibility alias.

## i18n — Every user-visible string must be translated

**This is a hard rule. Every user-visible string must go through the translation system.**

### In `.svelte` files

Always wrap text through the local `t()` helper, which is defined in each page as:

```ts
function t(key: string, params?: Record<string, string | number | null | undefined>) {
	return translate(data.locale, key, params);
}
```

This applies to:

- Template text content: `{t('Save')}` not `Save`
- HTML attributes: `placeholder={t('Search')}`, `aria-label={t('Close')}`, `title={t('Edit')}`
- `<option>` labels: `<option value="member">{t('Member')}</option>` not `Member`
- Dynamic data that comes from a fixed enum (role names, status values): translate them with a helper map
- Page `<title>`: `<title>{t('Dashboard')} | Expense Manager</title>`
- Default input values: `value={t('My expenses')}` not `value="My expenses"`

### In server `.ts` files

Always use `translate(context.locale, 'key')` for user-facing errors:

```ts
throw error(403, translate(context.locale, 'Permission denied.'));
throw error(404, translate(context.locale, 'Budget not found.'));
```

**Never** write: `throw error(403, 'Permission denied.')` — the English string will be shown even to pt-BR users.

When a service function does not receive a `WorkspaceContext`, add a `locale: SupportedLocale = 'en'` parameter and thread it from the caller.

### Adding new strings

1. Use the English string as the key in your template/server code.
2. Add the pt-BR translation to `src/lib/i18n/messages.ts` inside `ptBrMessages`.
3. The file is sorted alphabetically — add the key in the correct position.
4. Never add a string that is only in one place; if it's user-visible, it needs a pt-BR entry.

### Common mistakes to avoid

- Hardcoding English `<span>Email</span>` instead of `<span>{t('Email')}</span>`
- Raw database enum values rendered directly: `{invitation.status}` → translate to `{translateStatus(invitation.status)}`
- Catalog/example placeholder text: `placeholder: 'Operations'` → `placeholder: t('Example cost center')`
- `throw error(403, 'Permission denied.')` without `translate()`
- New service functions that throw errors without translating them

### Checking your work

After any change that introduces user-visible text, search for bare English strings in your diff:

- In `.svelte` templates, any visible text not inside `{t('...')}` is a bug
- In server `.ts` files, any `throw error(N, 'English string')` without `translate()` is a bug

The build does not enforce translation coverage, so this must be done by code review.
