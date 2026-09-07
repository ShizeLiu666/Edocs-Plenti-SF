# 决策记录(DECISIONS)

记录本项目已定决策、跨阶段待办与开放问题。**对话里达成的共识必须落到这里**,
不能只存在于聊天记录中。

规格:[eDocs-Plenti-Intake-开发规格.md](eDocs-Plenti-Intake-开发规格.md)

---

## D-001 模板代码原样导入,不在移植时顺手修改

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

初始 commit(`29846bf`)把 handoff 包的 `Code.gs` / `Tests.gs` /
`test-offline.cjs` **字节级一致**地导入,不做任何修改;第二个 commit 才
`git mv` 到 `src/` 与 `test/` 并加脚手架。

**为什么**:git 会把第二步识别为 rename,`git diff` 在 `src/Code.gs` 上是空的
—— 任何人日后都能一眼确认"移植进来的模板代码一个字没改",不用和 handoff
目录做人工比对。一边搬一边改,就没人能确认到底改了几处。

代价:仓库里会短暂存在模板的硬编码生产值,见 **TODO-1**。Jack 判定可审计
基线比这个代价更重要。

---

## D-002 Phase 1 只搬不改,一行业务逻辑都不动

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

规格 §2 说的"继承三样东西"(排除规则 / review 兜底 / 创建前防重锁)与
"不要继承购买意图猜测、`extractSender_`"全部属于 Phase 2 / Phase 3。

Phase 1 对代码的**唯一**修改是 `test/offline.cjs` 的一行路径解析:

```
path.join(__dirname, file)  →  path.join(__dirname, '..', 'src', file)
```

有意**没有**顺手做的事:`filename: file` 会让报错栈显示 `Code.gs` 而不是
`src/Code.gs`,可以改得更清楚,但那是无关改动,不碰,免得污染 diff。

---

## D-003 `src/Plenti.gs` 本期只放注释头

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

该文件出现在规格 §6 的 Phase 1 目录树里,但接口定义属于 Phase 3。本期只放
说明用途的注释头,**不写 `isPlentiSource_` / `parsePlentiReferral_` 的任何
函数签名**,避免跨阶段。

---

## D-004 handoff 包进仓库,冻结保留

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

`docs/edocs-plenti-handoff/` 原样保留在仓库内。

**为什么**:规格 §2 说的"一次性模板,不是上游依赖"指的是**代码不双向同步**,
不是要求物理删除。留在仓库里可以随时 diff 比对适配改了什么。该包是脱敏版,
不含 Client Secret、Access Token、Script Properties 实际值或客户原始邮件。

---

## D-005 `.gitignore` 屏蔽 `*.eml`;fixture 一律不用 `.eml` 格式

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

**为什么**:禁止事项 #5。2026-09-09 会议后会拿到 Plenti 真实样本,那时最可能
发生的事故是有人把真实 `.eml` 放进 `test/fixtures/` 当样本 —— 那就是真实客户
融资资料和身份证明进入 git 历史,而 git 历史极难彻底清除。现在挡住成本为零。

**并且**:Phase 3 的 fixture 一律用虚构的 `.txt` 或 `.json`,**即使内容是编的
也不用 `.eml` 格式**。从文件格式上就杜绝"顺手把真实样本存成 fixture"这条
路径。规则同时写在 `test/fixtures/README.md`。

---

## D-006 OAuth scope 按"大概率收不窄"规划

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

`appsscript.json` 照抄 handoff 示例,含 `https://mail.google.com/`(Gmail
完全权限:读 + 写 + 删),而本项目实际只需要读邮件和加标签。

**Apps Script 的内置 GmailApp 服务就是绑定该 scope 的。** 要收窄基本得改用
Gmail 高级服务直接调 REST API,那是另一套写法、另一次重写。Phase 4 会实测
确认,但**这条按"收不窄"记录,不是一个乐观的待办** —— 不要按"能收窄"规划。

因此缓解措施走流程而非技术:专用账号 `sf-intake` + Workspace 管理员审核授权。

---

## 跨阶段待办(TODO)

### TODO-1 硬编码生产域名 → `INTERNAL_DOMAIN` 【Phase 2 必须处理】

**这是 D-001 的代价,不能忘。**

`src/Code.gs` 第 51 行(`ivClassify_` 内部邮件排除)硬编码了生产域名:

```javascript
if(!from||/@sunterra\.com\.au$/i.test(from))return {kind:'internal',top:top};
```

**Phase 2 移植排除规则时必须改为 Script Property `INTERNAL_DOMAIN`,缺失即
抛错停止**,符合规格 §3 禁止事项 #2。

同类的其他硬编码值,Phase 2 一并复查(是否也需要走属性,或只是需要改值):

| 位置 | 硬编码值 | 备注 |
|---|---|---|
| `ivClassify_` L51 | `@sunterra.com.au` | **必须改属性** |
| `ivAttachSource_` L129 | 文件标题 `'Info email '` | 文案错误,本项目不是 info 邮箱 |
| `ivCreateCandidate_` L115 | `Company:'Individual / Residential'` | 规格 §5.9 标为"待定",需 Jack 确认是否适用 |
| `ivCreateCandidate_` L115 | `LeadSource:'Other'` | 规格 §5.9 要求改为 `Plenti`,**需先确认 picklist 有此值** |
| `ivReq_` L38 | API 版本 `v67.0` | 规格 §4 确认沿用 v67.0,无需改 |

### TODO-2 规格文档内部引用路径与实际不符 【规格更新时一并修正】

规格与任务描述中引用的路径,与仓库实际路径不一致:

| 文档中写的 | 实际 |
|---|---|
| `docs/开发规格.md` | `docs/eDocs-Plenti-Intake-开发规格.md` |
| `docs/handoff/` | `docs/edocs-plenti-handoff/` |

**以实际路径为准,不改文件名。** 后续如果规格文档更新,把这些引用一并修正。

另:规格提到 handoff 包含 5 个文件(`Code.gs` / `Tests.gs` /
`test-offline.cjs` / `README_CN.md` / `PLENTI_ADAPTATION.md`),实际是 8 个,
多出 `EXPORT_NOTES.md`、`appsscript.example.json`、`script-properties.example.json`。
`appsscript.json` 的 oauthScopes 即来自 `appsscript.example.json`。

---

## Script Properties 清单

所有环境相关值一律走 Script Properties,代码中不硬编码,**缺失即抛错停止**
(规格 §3 禁止事项 #2)。凭据不写进仓库,不发在聊天或邮件中。

### 已在模板中使用(Phase 1)

| 属性 | 用途 |
|---|---|
| `SF_LOGIN_URL` | 已核实的 Salesforce My Domain HTTPS 根地址;**先用沙箱** |
| `SF_CLIENT_ID` | 新建集成的凭据,**不复用 info 项目的** |
| `SF_CLIENT_SECRET` | 同上 |
| `INTAKE_MAILBOX` | eDocs 实际邮箱地址。**只用于来源说明文字,不切换邮箱** —— GmailApp 操作的是触发器实际执行用户的邮箱 |
| `INTAKE_ADMIN_ID` | 新 Lead 审核人的 Salesforce User ID,`005` 开头。见 README 的 Owner 未决风险 |
| `INTAKE_V2_START` | 明确时区的 ISO 上线时间,不自动回扫历史邮件 |
| `INTAKE_V2_ENABLED` | 默认 `false`,上线开关 |
| `EDOCS_ADAPTATION_VALIDATED` | 默认 `false`,验收后手动打开的安全锁 |

### Phase 2 / Phase 3 预计引入(尚未实现)

| 属性 | 引入阶段 | 用途 |
|---|---|---|
| `INTERNAL_DOMAIN` | **Phase 2** | 替换 `ivClassify_` 里硬编码的 `@sunterra.com.au`,见 TODO-1 |
| `EDOCS_GROUP_ADDRESS` | **Phase 3** | 收信范围过滤(规格 §5.7)。`list:<组地址>` 匹配 Google Groups 写入的 `List-ID` 头;具体操作符待样本验证,`deliveredto:` 作为备选 |
| `ATTACH_RAW_EMAIL` | **Phase 3** | 是否上传 `.eml` 原件到 Salesforce Files。**默认 `false`**(规格 §5.6)。代码路径写好但不启用,等 Jack 确认允许的数据范围后再开 |
| `PLENTI_TRUSTED_SENDERS` | **Phase 3** | 可信 Plenti 发件地址 / 域(规格 §5.1)。**格式待真实样本确认** —— 拿到样本后第一件事是打印全部邮件头,确认 Google Groups 是否保留了 `X-Original-Sender` 和 `X-Original-Authentication-Results` |

### 运行时写入(不要手工设置,不要清空)

`INTAKE_V2_WATERMARK`、`IV2_MSG_*`、`IV2_CREATE_*`、`IV2_REF_*`、
`IV2_ACCOUNT_*`、`IV2_REVIEW_CURSOR`、`IV2_VERIFIED_ACCOUNT_*`

由脚本运行时写入,参与去重和失败恢复。**不复制 info 邮箱的实际值,也不要
随意清空。**

---

## 开放问题(需 Jack / 业务侧决定,阻塞相应阶段)

| # | 问题 | 阻塞 | 规格出处 |
|---|---|---|---|
| Q1 | **Plenti 线索由谁跟进?** 目前全部指派给 `INTAKE_ADMIN_ID`,意味着 SLA 时钟开始跑但无人被分配联系客户 | **上线** | §5.9 |
| Q2 | `Plenti_Received_At__c` 字段命名需确认,并检查 org 中是否已有可复用字段。**脚本不自动创建 Salesforce 字段** | Phase 4 | §5.3 |
| Q3 | `LeadSource` picklist 是否已有 `Plenti` 值?没有需先加(Setup 操作,不由脚本做) | Phase 4 | §5.9 |
| Q4 | `Company` 字段:模板写死 `Individual / Residential`,是否适用于 Plenti 转介 | Phase 3 | §5.9 |
| Q5 | 数据留存范围:是否允许保存整份融资申请 / 身份证明。在拍板前 `ATTACH_RAW_EMAIL` 保持 `false` | Phase 3 | §5.6 |
| Q6 | referral ID 存哪里:Lead 自定义字段 vs Script Properties。**倾向 Lead 字段**(Properties 有 500KB 上限且不可靠),待样本确认 ID 格式后定 | Phase 3 | §5.4 |
| Q7 | 模板"老客户在 Account 上建 Completed Task"分支是否保留(默认关闭) | Phase 2 | §5.10 |
| Q8 | Business Hours 修正(当前是 Los Angeles + 24/7,须改 Adelaide + 南澳公共假期)。本项目之外的 Salesforce 配置任务,但在修好前任何"工作日"计算都是错的 | SLA 计算 | §4 |
