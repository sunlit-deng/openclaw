使用 $auto-pr-openclaw，在 openclaw/openclaw 中筛选尚未发布的新候选，实现、验证并自动发布合适的 contributor PR。先读技能 references/scheduled-candidates.md。目标是有明确用户价值、容易验证且值得合入的改动；不为凑数量或追求评分制造 PR。已有 PR 的修改交给另一个维护任务。

账号和授权：
读取 workspace/openclaw/accounts.json 的 sunlit / jjy，分别对应 sunlit-deng / RileyJJY。使用匹配配置的凭据完成 gh 查询和发布，不使用不明默认会话，不输出秘密。先实时查询两者在目标仓库的 open author PR 数；查询失败不是 0。新候选选择账号时严格优先 sunlit（少于 20）；sunlit 达到 20 才选 jjy（少于 20）；两者都满则 capacity-full，结束而不建工作区。
候选绑定账号后，续做时核对原选择证据、身份和当前容量；不因另一个账号临时空出名额就重写已完成提交。每次创建前立即重查所选账号，必须仍少于 20；有其他任务正在为同账号创建 PR 时先协调本地运行状态，不并发争抢名额。无法确认容量或所有权时停止创建。发布后核验作者、head owner、远端状态与数量。
允许通过技能 publisher 创建 ready-for-review PR；不创建 issue、不发表评论、不请求 review / ClawSweeper re-review，不绕过发布安全门。

每轮流程：
1. 先读自动化目录 candidate-state.json（不存在则初始化），优先续做一个仍有价值的未发布 workflow；只读对应 context-pack、进展和必要证据，避免从头翻完整 memory。若 workflow 已有 PR，记录本地交接给维护任务，不继续修改该 PR。
2. 容量允许后，复用共享 clone/store，刷新并固定一次 origin/main。每轮最多快速筛 6 个具体候选、深查 2 个、实现 1 个；建议探索不超过 15 分钟，总规划预算 60 分钟，最后 15 分钟留给验证发布或持久检查点。无需凑满数量，禁止无限扩大搜索池或反复扫描最近 40 个 queueable-fix。
3. 优先有当前 main 复现、已有仓库契约、低协调成本和小补丁的候选。对具体问题在创建 worktree/安装依赖前做轻量实时查重：issue/行为关键词、目标文件、helper/API 名称、近期已合并同形状实现，并检查明确的实现认领。精读疑似匹配，判定是否同一行为或回归测试；仅同文件不等于重复。已重复、已在 main 修好或有明确活跃同范围实现的候选及时淘汰。若 issue 短名单全部拥挤，可在同一预算内检查一个近期合并模式提示的本地 sibling 缺口，不开展全仓审计。
4. 对剩下的具体候选运行 scout，确认用户影响、根因假设、既有契约、最小改动和 proof 计划。计划必须写明生产入口、base/head 相同输入、预期差异、negative control，以及所需工具/运行环境；先验证其可用性。问题涉及 Gateway、浏览器、paired-node、Docker 或权限/持久化时，先确定真实边界与契约；不能用模块输出冒充集成证明，不能因 scout 高分就忽略设计空白。缺少真实问题或契约不明确的候选不进入实现。
5. 选中后使用 canonical worktree 和绑定账号，读取仓库及相关目录政策；复用共享 clone/store 和已有本地进展，不每轮另建完整 workspace。已有 workflow 后立即生成正式 live duplicate receipt，通过后才实现；candidate-score 在有实际 diff/body 等输入后运行，不给所有淘汰候选提前凑评分材料。
6. 实现最小修复和必要回归测试。测试、依赖或 gate 的本地问题先读精确失败、修复后复验，不把第一次失败直接当终态。遵循适用 preflight 和缓存规则，不重复手工重检查、不把可选 codex review 当发布前必需项、不通过切换 profile 来隐藏失败。只在输入或诊断发生变化后重试。重型平台搭建或必须扩大的验证范围超过本轮计划时保存进展和明确阻塞，不临时开第二个实现。
7. 提交任务自己的代码，完成必要 squash，再生成最终 HEAD 绑定 proof/preflight、body、score 与 gate。创建前最后轻量核验 duplicate、当前 main 是否已实现同一修复以及所选账号容量；main 仅前进不等于重做全部验证。有真实重叠则检查具体差异，已被上游修复就停止发布。
8. automaticPublication.eligible=true 且 blockers 为空时立即调用技能 REST publisher；仅当所有剩余 blocker 都符合技能允许的外部原因证据规则时使用 agent judgment。不绕过本地代码失败、重复、账号、HEAD/body、目标、租约、权限、脏工作区或政策问题。创建响应不确定时，先按精确 owner/head 查询是否已创建，禁止盲目再次创建。发布后核验远端 head/body、作者、目标、ready 状态和 maintainerCanModify；成功一个就结束。

持久状态和结果：
在 candidate-state.json 保存候选键（issue 或行为+文件）、相关 issue/PR、淘汰原因及重新进入条件、上次检查时间、观察的 main、账号选择和容量、workflow/worktree/local HEAD、已完成改动、验证收据、下一条具体动作及各阶段耗时。状态只用于调度，不能替代 gate 证据。
已重复/已修复候选在相关行为或竞争 PR 状态变化前不重做完整筛选；临时环境/API 阻塞记录 retryAfter。未知搜索结果不能当“没有重复”。保存有效未发布进展，下一轮优先恢复；不得用 in-progress 掩盖连续无进展。
如实报告 published、no-candidate、capacity-full、in-progress 或精确 blocked/external-blocked/needs-user-decision。没有合适候选是正常结果。简短说明候选、实际改动、验证、PR 链接或阻塞及耗时，不输出令牌、cookie、秘密或本机秘密路径。
