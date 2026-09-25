# Contributing to Tilecast

Thank you for helping build open signage infrastructure. By contributing, you agree that your contribution is licensed under AGPL-3.0-only.

1. Open an issue for substantial behavior or protocol changes before implementation.
2. Keep changes within the current milestone and preserve package boundaries.
3. Add tests for behavior changes and migrations for database changes.
4. Run `make format` and `make check` before opening a pull request.
5. Document public API or operational changes in the respective `docs/` Markdown file.
6. Update the public docs site in `apps/docs/` in the same pull request when you add or change something users see or do, such as a Studio feature, a setting, an install step, or a contributor workflow. Follow `apps/docs/STYLE.md`, add new pages to the sidebar in `apps/docs/astro.config.mjs`, and run `npm run docs:build`.

Commit messages should state the user-visible or architectural outcome. Pull requests must not present future or mocked features as working. Security reports belong in the private process described in `SECURITY.md`, not a public issue.
