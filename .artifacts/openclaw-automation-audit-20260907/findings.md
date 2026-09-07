# OpenClaw PR 维护自动化审计（2026-09-07）

结论：任务编排和技能中的停止规则都有问题；历史上还存在工作区与资源问题。
证据支持修改运行策略，但不足以证明某个模型或冲突算法本身存在缺陷。

## 已观察的证据

- 原 prompt 要求读取每个开放 PR 的评分/评论/CI，并将所有低于 Platinum 的 PR 纳入维护；没有每轮深度处理数量上限。
- memory 中多轮串行检查 27–29 个 PR；2026-09-05 09:30、10:55、13:30 的记录均没有远端发布。
- memory 同时记有成功：#126604 的代码修复、#138495 的 proof 更新等。流程并非完全不能发布。
- 旧技能原文：`A failed conflict receipt must stop for a user decision`；任务同时要求第一次收据失败后继续修复。这是可定位的规则冲突。
- review-gates.md 还残留“conflict resolution returns to normal validation and the Human Gate”，与后文已经授权的 conflict fast path 不一致。
- 2026-09-05 10:55 记录 clone/index-pack 卡住且仅剩约 2.6 GiB；本次 df 显示当前约 423 GiB 可用。历史资源不足不能视为当前事实。
- 2026-09-04 记录 #135296 已有本地修复和通过的 focused test，但 changed preflight 卡在 lint:core；另有 #110544 失败命令没有保留 stdout/stderr。
- 记忆中若干 `prWriteSkipped=true` 核验被列在发布描述中，无法据此统计实际修复产出。
- 先前任务记录显示曾全盘 find 进入 pnpm store，单次命令耗时约 275 秒；这说明宽泛本地搜索也会制造显著延迟，不能全部归因于模型思考。
- 开始审计时 prompt 的 updated_at 已是本次之前刚更新的版本。较早失败记录不能直接用来评价这份最新 prompt 的实际效果。

## 已实施

1. 原自动化原地更新；ID、ACTIVE 状态、每天六次运行、项目、local 环境、gpt-5.6-luna / xhigh 均保留。
2. Prompt 从 4774 字符减到 2550 字符。只为具体评论、真实冲突、PR 引起的 CI 或明确 proof 请求进入维护。
3. 每轮默认一个 PR，明确阻塞时最多一个备选。45 分钟规划预算，末段预留验证/发布或持久检查点；不是强制杀进程。
4. 添加技能 references/scheduled-maintenance.md，规定按变化选择验证路径、恢复本地进展、记录阶段耗时与重试触发条件。
5. 统一 SKILL.md、review-gates.md 的失败规则：停止发布，允许已授权范围内有证据的诊断修复；仍禁止绕过 patch 等价性、无理由扩大 scope 或自动升级重检查。
6. worktree-layout.md 明确区分本地未发布进展与陈旧工作区，复用共享 clone/store，避免反复冷启动。
7. 更新 memory 的当前策略说明，保留原始历史。下一轮初始化结构化状态；本次没有把历史 head/收据伪装成实时状态。
8. 区分 published、no-action、in-progress、blocked、external-blocked、needs-user-decision；无远端变化不能计作发布。

## 验证和限制

- `node scripts/validate-skill.mjs .codex/skills/auto-pr-openclaw` 通过：7 个 reference、24 个脚本引用。
- `git diff --check` 通过。
- 自动化更新后重新读取 TOML，核对保留字段和新版 prompt，确认 ACTIVE。
- 补充 quick_validate.py 因当前 Python 缺 PyYAML 无法执行；项目自带的结构验证器已通过。
- 此次仅改变 prompt 和技能文档，没有修改 publisher/冲突算法，没有执行真实 PR 发布，也没有测得提速比例。
- 现有脚本中的用户未提交修改保持不变；不将这些改动归入本次优化。
- 下一轮看四项：扫描占时、setup 占时、验证占时、实际发布数量；同时检查是否从检查点续做以及相同阻塞重跑次数。模型调整应在这些数据之后单独评估。

## 文件

- `automation.before.toml`：本次修改前原配置备份。
- `prompt.after.md`：已保存到自动化的新版 prompt。
- 原历史记忆：`/Users/yangjiajun/.codex/automations/openclaw-pr/memory.md`。

官方参考：
[Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app)
说明定时任务可引用项目技能；本次根因判断来自本机配置与历史执行证据。
