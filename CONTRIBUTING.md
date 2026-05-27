# Contributing

Thanks for working on the Airport Inspection Platform. This project follows a deliberate process so that the Git history itself reflects production-quality engineering discipline.

This document is the **short reference**. The authoritative process doc lives in the project planning folder as `GIT_FLOW.md` alongside the project brief, folder structure, and role catalog.

---

## TL;DR

- `main` is always demo-runnable. `develop` is always green.
- All work flows through `feature/*`, `bugfix/*`, `release/*`, or `hotfix/*` branches.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
- PRs use the template. Self-review before requesting review. < 400 lines of diff target.
- Squash-merge feature/bugfix PRs into `develop`. Use merge commits for `release/*` and `hotfix/*` back into `main`.

---

## Branches

| Branch | From | To | Merge |
|---|---|---|---|
| `feature/<scope>` | `develop` | `develop` | squash |
| `bugfix/<issue>` | `develop` | `develop` | squash |
| `release/v0.X.0` | `develop` | `main` + back-merge `develop` | merge commit |
| `hotfix/<issue>` | `main` | `main` + back-merge `develop` | merge commit |

### Naming

- `feature/phase1-monorepo-skeleton`
- `feature/phase2-redis-pubsub`
- `feature/sensor-gateway-lidar-simulator`
- `feature/validation-layer-04-source-of-truth`
- `bugfix/ws-reconnect-flicker`
- `hotfix/critical-startup-race`
- `release/v0.2.0`

Avoid: `wip`, `joey-stuff`, `fix`, `branch-2`.

---

## Commit messages

Use Conventional Commits:

```
<type>(<scope>): <subject>

<optional body wrapped at 72 chars>

<optional footer — Refs #N, BREAKING CHANGE:, Co-Authored-By:>
```

Allowed types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `style`, `revert`.

Examples:

```
feat(sensor-gateway): add LiDAR simulator with packet-loss fault injection
fix(ws-broadcaster): handle reconnect during burst fanout
docs(adr): add ADR 0008 — validation engine design
test(validation): cover layer-04 source-of-truth contradiction path
chore(deps): bump fastify to 4.27.0
ci: add Playwright e2e workflow with browser matrix
```

---

## Pull requests

1. Branch from `develop` (or `main` for hotfixes).
2. Implement; commit using Conventional Commits.
3. Push the branch and open a PR via the template.
4. **Self-review the diff** before requesting review.
5. Link to an issue and assign the appropriate phase milestone + labels.
6. Squash-merge once CI is green and review (if required) is complete.

### PR size discipline

- Target < 400 lines of diff (excluding lockfiles, generated code).
- Hard limit: > 800 lines → split or justify in the PR description.
- One concern per PR. If the title contains "and", split it.

---

## Releases

When a phase milestone is complete:

```bash
git checkout develop && git pull
git checkout -b release/v0.X.0
# bump version, update CHANGELOG, final QA + demo dry-run
git push -u origin release/v0.X.0
gh pr create --base main --title "release: v0.X.0 — <phase name>"
# After merge:
git checkout main && git pull
git tag v0.X.0 && git push --tags
# Back-merge:
gh pr create --base develop --head release/v0.X.0 --title "chore: back-merge v0.X.0 to develop"
```

### Phase-to-version map

| Phase | Tag |
|---|---|
| Phase 1 — Skeleton | `v0.1.0` |
| Phase 2 — Real-Time | `v0.2.0` |
| Phase 3 — AI Pipeline | `v0.3.0` |
| Phase 4 — Incidents | `v0.4.0` |
| Phase 5 — Hardening + Demo | `v1.0.0` |

---

## Hotfix

If `main` breaks:

```bash
git checkout main && git pull
git checkout -b hotfix/<issue-slug>
# minimal fix + regression test
git push -u origin hotfix/<issue-slug>
gh pr create --base main --title "fix: <issue>"
# After merge: tag patch version, back-merge to develop
```

---

## CI gates

A PR cannot merge unless CI is green:

- Lint (eslint, prettier)
- Typecheck (`tsc --noEmit`, Python type checker)
- Unit tests (Vitest + pytest)
- Affected integration tests
- Docker build for changed services

Release branches additionally require the full e2e suite, full integration suite, coverage thresholds, and a CHANGELOG entry.

---

## Stale branch hygiene

- Branches are deleted automatically after merge.
- Unmerged feature branches > 14 days are rebased + merged or closed with explanation.
- Long-running branches (> 2 weeks) are flagged and either split, rebased, or scoped down.

---

## Local development

Once the Phase 1 skeleton lands, you'll be able to:

```bash
docker compose up         # full stack
npm run test              # all tests
npm run test:unit         # unit only
npm run test:e2e          # Playwright e2e
npm run lint              # lint + format check
npm run typecheck         # tsc --noEmit across workspaces
```

Until then, this repo is bare scaffolding.

---

## Questions / disagreements

- Process disagreements → [Project Manager role doc](#) (in planning folder).
- Scope disagreements → [Product Manager role doc](#).
- Architecture disagreements → [Principal Architect role doc](#).
