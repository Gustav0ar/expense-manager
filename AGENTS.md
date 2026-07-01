# Agent Guidelines

- Write default product UI text, documentation, server messages and tests in English.
- When a user-facing string needs pt-BR support, add the English source string to the UI/server code and add the pt-BR translation in `src/lib/i18n/messages.ts`.
- Do not hardcode pt-BR text outside i18n dictionaries, except for compatibility aliases that intentionally accept external input such as CSV headers.
- When writing pt-BR text for translations, documentation, messages, tests or fixtures, use correct spelling with accents and special characters: `descrição`, `configuração`, `usuários`, `ações`, `permissão`, `código`, `não`, `orçamento`, `relatórios`.
- Preserve unaccented text only when it is a technical identifier, route, database column, environment variable, API key, filename or external compatibility alias.
