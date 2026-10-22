# Agent Hub release notes

This draft retains the original Hub contract-governance boundary from the
private Utilities development history. It does not import unrelated Utilities
release notes or claim a standalone release. Current installation instructions
are in README.md; historical instructions below describe their original date.

## 2026-08-25 — Контракты Agent Hub фиксируют принятые решения

- `Автор`: `IIITYRAELIII` (GitHub UID `95281881`).
- `Компоненты`: `agent-hub`, `agent-hub-test-contour`.
- `Для кого`: разработчики и пользователи Agent Hub.
- `Действие`: `none`; реестр используется из текущего дерева Utilities.
- `Контракты`: `SYS-001`, `MSG-001`, `TURN-001`, `UI-001`, `RST-001`,
  `PERF-001`, `REL-001`.
- `Проверка`: выполнить `npm run contracts:check` в `AgentHub`; проверка должна
  подтвердить семь уникальных контрактов и доступность каждого документа.
- `Установка/обновление`: `use-in-place`.
- `Перезапуск`: не требуется; Test Contour обновляется автоматически.
- `Изменения`: добавлены машинный реестр принятых контрактов, ADR по единому
  durable command ledger и логическим ChangeSet, карта повторных инцидентов и
  обязательная проверка контрактов и новых Agent Hub changelog entries в общем
  syntax check. CLI выбирает контракты
  по изменяемым путям, roadmap задаёт проверяемые этапы миграции, а описание
  release registry отделяет необходимый coordination ledger от дефектной
  turn-scoped реализации. Контракты фиксируют
  неизменяемые identity/state/SLO-границы для задержек, дублей, финалов,
  mark-read, рестарта и релизов.
