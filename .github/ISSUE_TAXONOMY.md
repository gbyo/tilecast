# Issue metadata taxonomy

Tilecast uses GitHub's native issue metadata so each mechanism has one job.

## Issue types

Use exactly one native issue type:

- **Bug** — existing behavior is broken, incorrect, or unreliable.
- **Feature** — a new user-facing capability or meaningful product enhancement.
- **Task** — maintenance, documentation, refactoring, CI/tooling, migrations, or other work that is neither a bug nor a feature.

Do not recreate these as labels.

## Issue fields

Use account-level issue fields for structured planning metadata:

- **Priority** — Urgent, High, Medium, or Low.
- **Effort** — High, Medium, or Low.

Pin both fields to Bug, Feature, Task, and untyped issues during migration. Do not create priority or effort labels.

## Labels

Labels have two purposes only:

1. **Area/component labels** identify where the work applies. An issue may have more than one when it spans components, for example `studio`, `server`, `android player`, `linux player`, `iOS app`, or `documentation`.
2. **Cross-cutting or automation labels** capture metadata that remains useful across types or on pull requests, such as accessibility or dependency/CI automation.

Pull requests do not support issue types or issue fields, so PR-only automation labels remain valid.

Do not use labels for issue type, priority, effort, who/what discovered an issue, or which tool created it.

## Retired labels

The following labels are redundant or provenance-only and must not be applied to new issues:

- `bug` — use Type: Bug.
- `enhancement` — use Type: Feature.
- `local LLM` — discovery provenance is not issue taxonomy.

Existing issues can be migrated to native types before these labels are deleted.
