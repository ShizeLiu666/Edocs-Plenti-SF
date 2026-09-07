# 导出范围与注意事项

## 来源与整理

读取了当前 Apps Script Code.gs（64,562 字符）。从中提取主运行函数和回归测试，未打包嵌入的历史备份和一次性客户补救函数。代码排版做了压缩整理，不是逐字节原文件归档。

当前核心分类、匹配、字段补录、Description 去重、标签及状态函数按导出时源代码保留。主要纯逻辑函数已与源函数去空白指纹核对；测试仅用示例个人信息。未导出 Salesforce 元数据或运行状态。

## 仅在本地分享副本中的安全变更

- `SF_LOGIN_URL` 不再默认指向 Sunterra 生产域；未配置就停止。
- 原写死的管理员 User ID 改为 `INTAKE_ADMIN_ID`，未配置就停止。
- 原 Description 的 info 邮箱来源改为 `INTAKE_MAILBOX`；该值不决定 Gmail 实际账号。
- 原生产域的记录链接改由 API 返回的 instance_url 生成。
- 在定时入口增加 `EDOCS_ADAPTATION_VALIDATED` 安全门槛。
- `enableIntakeV2AfterValidation` 在分享版中直接抛错，不再检查某个生产 Flow ID 或设置历史起始日期并启用。
- 回归测试拆至 `Tests.gs`，客户标识换成虚构示例；本地补充停用安全锁测试。

以上修改**没有同步回生产**。当前仍保留 Sunterra 自定义字段、分类规则及部分文案（例如文件标题 Info email），供同事明确识别需要适配的位置。

## 排除的一次性工具

`repairConfirmedEmailCases`、`preserveOriginalIntakeCode_`、`activateAndRepairNoFieldsUpgrade`、`verifyNoFieldsUpgrade`、`inspectAddressConfiguration`、`repairBoundaryEmailLabels`、`repairJasonReplyOnly`、`migrateLeadOnlyLabels`、`repairFridaReplyOnly`、`recoverTristanWebLead`、`verifyReplyWithoutTasks`、`auditHistoricalReplyLabels`、`reconcileHistoricalReplyLabels`、`repairTeddySalesEnquiry`、`repairRyanEnquiry`。

不要把这些特定客户修复逻辑复制到 edocs。未打包其他旧文件、部署和触发器，所以这不是可回滚整个生产系统的备份。

## 继承的限制（不是本次打包已修复的功能）

- 规则是正则匹配，不是理解所有邮件的 AI。补录匹配在无明确引用时可能依赖唯一活跃 Lead，同邮箱并不必然同一需求。
- 并非每条 review 都会创建 Salesforce 审核记录；普通非销售 review 也不会加 Lead 标签。
- 目前部分错误会阻止 watermark 前移，积压需监控。Script Properties 的容量有限，长期增长要设计外部状态存储或安全清理策略。
- Apps Script 锁只保护同一项目，不能保证跨系统 exactly-once；标签失败、文件失败、Lead 已写入等中间状态必须测试。
- `[Intake: ID]` / `[Gmail:ID]` 存在可防同封正文重复；人工删除标识、转发、供应商重发等仍需更稳定的业务去重。
- 新建 Description 会截断至 32,000 字符；补录超限会报错。`.eml` 大小门槛按字符串长度检查，不是完整附件字节配额验证。
- 代码不发送首次回应邮件。Salesforce 既有自动回复、分配和其他 Flow 可能被创建动作触发，必须单独验证。
- 不包含 Plenti 解析器、真实 Plenti 样本、授权检查实现或稳定 referral ID 存储实现，不能直接上线。

## 本次验证

2026-09-07 在本地 Node.js 隔离上下文运行 Tests.gs：分类、地址、标签、Description 去重测试及分享版安全门槛全部通过。网络调用被测试桩阻止。没有发送邮件，没有新增或修改 Salesforce 记录。测试通过不代表 edocs / Plenti 端到端集成已验收。
