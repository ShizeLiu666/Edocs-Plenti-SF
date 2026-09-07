# Sunterra 邮件 → Salesforce Lead 交接包

整理日期：2026-09-07。来源：当前 info 邮箱 Apps Script 项目的 Code.gs。

这是一份**脱敏、默认停用的可复用代码交接版**，不是生产项目完整备份，也不是已经适配好的 Plenti 成品。导出时没有修改 info 邮箱的线上代码、触发器或 Salesforce 数据。

## 包内文件

- `Code.gs`：当前在用主流程的分享版，包含最近的 Description 邮件 ID 去重修复。
- `Tests.gs`：按当前回归测试整理，客户姓名、地址、电话和 CRN 替换为示例。
- `test-offline.cjs`：本地 Node.js 回归测试，不连接 Gmail/Salesforce。
- `script-properties.example.json`：需要自行配置的属性清单，密钥留空。
- `appsscript.example.json`：建议的最小 Apps Script manifest 示例，**不是从生产导出的原 manifest**。
- `PLENTI_ADAPTATION.md`：同事首先阅读的业务适配及上线验收清单。
- `EXPORT_NOTES.md`：相对生产源文件的整理范围、安全调整及已知限制。

未包含：Client Secret、Access Token、Script Properties 的实际值、客户原始邮件、处理状态、人工确认的客户关联、历史一次性修复函数、旧版本源码备份。Salesforce Flow、重复规则、布局、权限和 Apps Script 触发器也没有导出。仅复制代码不会复制这些配置。

## 当前实现了什么

1. 定时读取 Gmail，以每封邮件的 ID 记录处理状态；脚本锁防止同一个项目并发运行。
2. 对客户直接销售询问进行规则分类；创建待审核 Lead，而非直接交给销售。
3. 回复邮件在可以确定目标时补录至原记录：提取电话、地址等，空字段补充，冲突不直接覆盖；正文追加至 Description，并回读校验。
4. 同一邮件的 `[Intake: ID]` 或 `[Gmail:ID]` 已存在时，不重复追加正文，保留人工编辑。
5. 原始邮件保存为 Salesforce File（`.eml`），原始附件包含在邮件文件内，不等于逐个提取为独立附件。
6. 根据处理状态同步三个 Gmail 标签：`SF-Lead-Created`、`SF-Lead-Review`、`SF-Lead-Updated`。不归档、不删除、不自动标记已读；标签按整个会话汇总，因此 Created 和 Review 可以同时存在。

注意：`SF-Lead-Review` 既可能对应已创建待审核的 Lead，也可能是尚未唯一匹配的销售邮件；不能假设每个 Review 标签都有 Salesforce 记录。只有成功回读并符合条件时才显示 Updated。

补录函数不创建 Task。不过当前老客户新询问分支仍会在 Account 上创建一条 Completed Task，用于记录关联。是否保留必须由新项目负责人决定；这不是补录 Task。原版还包含已转换 Lead 对应 Opportunity 的邮件留存分支，Plenti 项目若只做 Leads，应在适配时明确禁止跨阶段写入。

## 如何交给同事

先阅读 `PLENTI_ADAPTATION.md`，拿到经授权的 Plenti 邮件样本，完成解析后再配置，而不是复制后立即设定时器。

1. 使用有权访问 edocs 邮箱的独立 Google Workspace 用户新建 Apps Script 项目。**GmailApp 操作的是实际执行用户的邮箱**，不是由 `INTAKE_MAILBOX` 属性或浏览器 `/u/2` 决定；该属性只是记录来源文字。若 edocs 是群组或别名，需要先明确实际收信账号，不能直接假定可用。
2. 复制 `Code.gs`、`Tests.gs` 到新项目；不要覆盖 info 项目。需要显式 manifest 时，在新项目的 `appsscript.json` 中参考示例，并核实权限。GmailApp 需要较广泛邮箱权限，应使用专用账号并由管理员审核。
3. 新项目设置 Script Properties。JSON 示例不会自行导入，密钥只通过获准的安全方式配置，不发在聊天或邮件中。
4. Salesforce 使用经管理员批准的 External Client App / client credentials 及 Run As 用户，按实际对象、字段和文件操作授权。不要为了运行本包授予全员管理员权限。
5. 先运行离线测试、沙箱读连接测试，然后在隔离环境跑完整收件 → Lead → 更新 → 标签测试。`testSalesforceClientCredentials` 只验证只读 API 连接，不证明写入权限或 Flow 正确。
6. 人工验证审核/分配门槛、通知不会骚扰真实销售后，设置明确上线起始时间，再启用新项目唯一的时间触发器，入口 `runSalesforceLeadIntake`。触发器由 edocs 实际执行账号创建。
7. `INTAKE_V2_ENABLED` 和 `EDOCS_ADAPTATION_VALIDATED` 默认为 false。第二个属性只是交接安全锁，**不是自动检测 Plenti 适配完成**；只有负责人验收后才改为 true。旧自动启用辅助函数在本包已禁用。

## 必填属性

| 属性 | 用途 |
|---|---|
| SF_LOGIN_URL | 已核实 Salesforce My Domain 的 HTTPS 根地址；先用沙箱 |
| SF_CLIENT_ID / SF_CLIENT_SECRET | 新集成获准使用的凭据，本包不提供 |
| INTAKE_MAILBOX | edocs 实际邮箱地址，只用于来源说明，不切换邮箱 |
| INTAKE_ADMIN_ID | 新 Lead 审核人的 Salesforce User ID，以 005 开头 |
| INTAKE_V2_START | 明确时区的 ISO 上线时间，不自动回扫历史邮件 |
| INTAKE_V2_ENABLED | 默认 false，上线开关 |
| EDOCS_ADAPTATION_VALIDATED | 默认 false，验收后的额外安全锁 |

`INTAKE_V2_WATERMARK`、`IV2_MSG_*`、`IV2_CREATE_*`、`IV2_REF_*`、`IV2_ACCOUNT_*` 等由运行写入，不复制 info 邮箱的实际值。不要随意清空状态；它们参与去重和失败恢复。

## Salesforce 依赖

当前代码沿用 Sunterra 的 API v67.0 和以下配置，并非通用 Salesforce 默认值：

- Lead：`Lead_Category__c`（`Other` / `New Sales Enquiry`）、`Contact_Attempt_Count__c`、状态 `New` / `Unqualified`、LeadSource `Other`。
- Account：`Customer_Reference_Number__c`、`Account_Email__c`、`PersonEmail`、`PersonContactId`（依赖 Person Accounts）。
- 标准地址代码字段 `StateCode`、`CountryCode` 及相应 picklist 配置。
- 原始邮件文件的 ContentVersion / ContentDocumentLink 权限。
- 如保留老客户日志和已转换记录分支，还依赖 Task、Contact、Opportunity 读写权限。

这些名称需要逐项核实；若目标组织不具备，不要自动新建 Lead 字段来凑。优先复用已有字段并修改映射。脚本本身不创建 Salesforce 字段，也不部署轮流分配 Flow。

## 本地测试

安装 Node.js 后，在解压目录执行：

```sh
node test-offline.cjs
```

本次打包已通过离线分类、地址解析、标签、Description 去重与默认停用测试。未连接 edocs、未使用真实 Plenti 样本，也没有做该新集成的生产验收。

## 停用和恢复

需要停止时，将新项目 `INTAKE_V2_ENABLED` 设为 false，并停用该项目触发器。不要改 info 项目。保留状态及已创建记录，先核对 API 成功但标签失败等情况，再重试；不要通过删除所有状态来强制重跑历史邮箱。
