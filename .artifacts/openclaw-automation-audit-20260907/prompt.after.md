使用 $auto-pr-openclaw 维护 openclaw/openclaw 已发布的 PR，先读技能 references/scheduled-maintenance.md。目标是落实评论中的具体修复、解决真实合并冲突，并把通过验证的改动发布到远端。评分只作为反馈，不以达到 Platinum 为完成条件。

授权范围：只维护 author 为 sunlit-deng 或 RileyJJY 的开放 PR。使用 workspace/openclaw/accounts.json 已配置账号，按 live head owner 选择 profile，分别核对 PR author、head owner/ref、提交身份和权限。允许提交代码、按技能推送现有 PR 和更新 PR body；不创建 PR/issue、不发表评论、不请求 review 或 ClawSweeper re-review。不绕过身份、HEAD/body、目标、租约、maintainer edit、冲突等价性或其他发布硬门。

每轮执行：
1. 先读取自动化目录 maintenance-state.json（不存在则初始化）以及选中 PR 的 context-pack/进展。用账号隔离的 gh 查询一次开放 PR 简表；对比 live head、review/comment 的 ID、更新时间或内容摘要、CI run/check 状态与实际 mergeable。详细评论、未解决 inline threads、失败日志和 diff 只读入选 PR。unknown mergeability 不是冲突，pending CI 不是失败；旧 review 的具体问题需对照当前代码判断，不能仅因 review SHA 旧而丢弃。
2. 优先续做可安全完成的本地修复，再按 P1、真实冲突、其他具体 review/PR-caused CI/proof 请求排序，同优先级先处理最久未尝试的 PR。低于 Platinum 但没有具体待办的 PR 记 no-action。每轮集中完成一个 PR；若存在明确阻塞，最多再尝试一个备选，禁止逐个深挖全部 PR。建议总预算 45 分钟，最后 10 分钟留给验证发布或可恢复检查点；不要临近预算才启动另一个 PR。
3. 对选中 PR 写一个简短可执行待办：评论/冲突证据、预期行为、需改文件、最小验证、完成标准，随后直接修改。复用 canonical worktree、共享 clone 和 pnpm store。先比对远端、保存的起点、本地提交和未提交改动，再决定是否需要 prepare；本地有未发布修复不等于 worktree 陈旧。恢复必须保留原分支、patch、必要未跟踪文件和证据。禁止每轮另建日期命名的完整 clone/store；主 clone 脏不等于无法创建隔离 worktree。不得覆盖其他任务或用户改动。
4. 按实际变化选择一条验证路径：无冲突纯 rebase 用专用快速路径；真实冲突用 start/record/finish、显式 allowedFiles、focused validation 和 conflict preflight；review 代码修改用适用 preflight；仅 body 修改只刷新相关 body/gate 证据。不为追赶 main 无故 rebase，确需 rebase 时固定一次 target。复用指纹仍有效的验证，不重复跑已通过重检查；proof 按明确 review 要求和失效范围补齐，不为刷分另造复杂 harness。
5. 失败先读精确输出，修复可确认的代码、测试、依赖或收据输入问题，再复验。冲突收据失败停止发布，但允许保留原补丁和失败收据后，在既有授权及安全范围内做一轮有依据修复。禁止无理由重复命令、把漂移说成外部原因、扩大 scope 来迎合收据或自动升级全量检查。Docker proof 缺环境时可先检查并尝试启动本机 Docker。产品/兼容性决策必须指出仓库契约无法确定的具体选择，不能用“需要决策”代替实现工作。
6. 修改完成后先提交任务自己的代码，按技能完成必要 squash，再生成最终 HEAD 绑定的 proof/preflight、body 验证和 gate。门禁中的可修本地问题继续修复。gate 清零后立即调用技能 publisher，或仅在所有剩余 blocker 都满足技能的外部原因证据规则时使用 agent judgment。核验远端 head/body、目标及 maintainer edit；不能停在“本地测试通过”。不等待评分刷新，不自动请求复审。

续做和防空转：
每个实质阶段保存 maintenance-state.json 的当前 PR、remote 起点/local HEAD、worktree/workflow、固定 base、问题摘要、review/CI 指纹、改动、验证收据、失败原因、已尝试修复、下一条具体动作和 intake/setup/fix/validation/publish 耗时。该状态只作调度进展，不能代替发布收据。
相同 head、问题、失败原因和相关环境未变时，只做轻量状态核验，不重跑重验证；记录明确 retryAfter 或恢复触发条件。新增评论、相关 upstream/scope 变化、环境恢复或有新修复方案时重试。旧版只有文字 blocked 的记录允许一次重新诊断，不能永久跳过。无需每轮重读完整 memory 历史。
结果如实区分：published（确有远端改动且核验成功）、no-action（无需改动或发布无变化）、in-progress（已有可恢复进展和下一步）、blocked（精确本地技术阻塞）、external-blocked（有外部证据）、needs-user-decision（真实必要决策）。连续无进展不能反复写 in-progress。

最终只报告选中 PR 的具体问题、实际改动、验证、是否发布及耗时；未发布时给出精确阻塞和下一步。安全门保留，完成度以已解决问题和实际远端更新衡量。
