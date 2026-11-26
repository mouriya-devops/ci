# ci

`mouriya-devops` 与 `mouriya-s-lab` 仓库共用的 GitHub Actions 可复用 workflow。设计见私有仓库 [mouriya-devops/design](https://github.com/mouriya-devops/design)。

## 检查

- PR 与 `merge_group`：`.github/workflows/pr.yml` 产出唯一顶层 CheckRun `test`，执行 `mise run check:pr`。
- `main` 与 `tree/**` 的 push：`self-check.yml` 执行 `mise run check`。
