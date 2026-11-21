# Fork 优先的更新与优化保留

目标：插件更新按 **上游 → 个人 fork → 本地安装** 流转。本地缓存即使被替换，优化仍保存在 fork 的 Git 历史中。

## 固定分工

- `upstream`：原始上游仓库；`origin`：当前用户的 fork。
- `master` 只镜像上游正式代码，不直接提交本地优化。
- `dev` 保存经过验证的优化；具体修改先在独立修复分支完成，再合入 `dev`。
- 开发副本必须位于 ZCode 管理的 `plugins/cache/`、`plugins/marketplaces/` 之外。不要修改安装缓存或托管市场副本来保留优化。

## 用户说「更新该插件」时

1. 确认开发副本无未提交改动，`origin`、`upstream` 指向正确；若需重建副本，从 fork 完整克隆后再添加 `upstream`。
2. 同步上游：`git fetch upstream --prune`；在 `master` 执行 `git merge --ff-only upstream/master`，再推送 fork 的 `master`。这不是把 `dev` 合入正式分支。
3. 保留优化：切到 `dev`，执行 `git merge --no-edit master`。冲突必须显式解决；禁止用 `reset --hard`、强制检出或覆盖文件消除冲突。
4. 验证合并后的命名、锁、Hook、发布构建和受影响插件测试；确认旧优化仍有效。
5. 新优化从 `dev` 建独立分支，先写契约测试，再实现、验证、提交并推送 fork；需要额外恢复点时推送 `preserve/<主题>` 标签。
6. 仅从已提交、已推送、已验证的 fork 提交构建发布物，再更新本地安装。正式合并、公开发布和推送按当时授权执行。
7. 更新后保留外置配置、状态和提示词，核对插件版本，执行 `status / doctor / probe` 与真实 Stop 验收。

**保护边界**：未提交或未推送的本地改动不受 fork 保护。更新本地安装前，必须先把需要保留的优化提交并推送到 fork。
