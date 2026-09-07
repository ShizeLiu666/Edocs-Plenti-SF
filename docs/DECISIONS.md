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

## D-007 定位调整:Plenti 是主干,Code.gs 降级为工具库

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 2

**本条覆盖规格 §6 对 Phase 2 / Phase 3 的原有描述。** 规格 §6 Phase 3 写的是
"在 `ivProcess_` 之前插入 Plenti 分流",隐含模板 `Code.gs` 是主干。现在反过来:

- 本项目**只处理 Plenti 转介线索**,不处理客户直接询价
- `src/Plenti.gs` 是主干,定时入口直接调 `plProcess_`
- `src/Code.gs` 降级为基础设施工具库(Salesforce REST、属性、状态、标签、
  定时入口与两道安全开关)
- `src/Legacy.gs` 隔离 info 模型专有逻辑

规格原有的 Phase 2(移植三样东西)与 Phase 3(Plenti 骨架)合并执行,
因为在新定位下它们是同一件事。

**为什么**:`Code.gs` 里 info 模型专有的业务逻辑(购买意图猜测、回复补录、
老客户 Account 匹配、已转换 Lead 写 Opportunity)在 eDocs 项目里一条都用不上。
留在主流程里会变成没人敢删又没人看得懂的死代码,而且每一条都是潜在的误触发
路径。

---

## D-008 函数三分类

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 2

模板 `Code.gs` 的 32 个函数按下表分流。KEEP 21 个留在 `src/Code.gs`,
DISABLE 11 个原样移入 `src/Legacy.gs`,ADAPT 的部分为 Plenti 重写进
`src/Plenti.gs`(原函数含 DISABLE 片段的整体进 Legacy)。

### KEEP —— 基础设施,留在 Code.gs

`getSalesforceClientCredentialsToken_` · `testSalesforceClientCredentials` ·
`INTAKE_V2`(变量) · `ivAdmin_` · `ivSource_` · `ivRecordUrl_` · `ivReq_` ·
`ivQuote_` · `ivQuery_` · `ivKey_` · `ivGet_` · `ivSave_` · `ivLabel_` ·
`ivLeadFields_` · `ivAttachSource_` · `ivSupplementDescription_` ·
`ivLeadLabelFlags_` · `ivSyncLabels_` · `runIntakeV2` ·
`runSalesforceLeadIntake` · `enableIntakeV2AfterValidation` ·
`ivRefreshOutstanding_`

其中就地修改的四处(全部带 `[Phase 2]` 注释):

| 函数 | 改了什么 | 为什么 |
|---|---|---|
| `INTAKE_V2` | `version` 字符串 | 标识本阶段 |
| `ivAttachSource_` | 加 `ATTACH_RAW_EMAIL` 开关(默认关);标题 `'Info email '` → `'eDocs email '` | 规格 §5.6 / TODO-1 |
| `runIntakeV2` | 检索收窄为 `list:<EDOCS_GROUP_ADDRESS> …`;改调 `plProcess_` / `plRefreshReview_` | 规格 §5.7 / D-007 |
| `ivRefreshOutstanding_` | 改调 `plProcess_` / `plRefreshReview_` | D-007 |

新增三个属性读取器:`ivInternalDomain_` · `ivGroupAddress_` · `ivAttachRawEmail_`。

`ivSupplementDescription_` 在 Phase 2 没有主干消费者(它的消费者
`ivRecordReply_` 是 DISABLE),但 `Tests.gs` 在测它,不算死代码 —— 与 ① 的
判定标准一致。Q6 定了之后更新路径回来会用到它。

### ADAPT —— 逻辑借鉴,为 Plenti 重写

| 原函数 | 借鉴什么 | 丢掉什么 | 新函数(Plenti.gs) |
|---|---|---|---|
| `ivClassify_` 前半段 | 内部 / SF 通知 / Web-to-Lead 失败 / 测试邮件 / 退信 / 自动回复的全部正则 | 后半段购买意图猜测 | `plExclude_` |
| `ivClassify_` 招聘 + 推广 + 语音留言 | 三段正则原样 | —— | `plUntrustedReason_`(只跑在不可信分支) |
| `ivResolve_` | 按客户邮箱查 Lead;`[Intake: msgId]` 判断;有活跃 Lead → review | reply / Opportunity / Account 分支 | `plResolve_` |
| `ivCreateCandidate_` | 标记检查;`IV2_CREATE_` 防重锁 requested→created;创建后回读 | Account 文案、Completed Task、发件人=客户 | `plCreateLead_` + `plLeadPayload_` |
| `ivProcess_` | 状态机骨架:prior 幂等 → 分流 → 写中间态 → 写终态;catch 一律落 error | `extractSender_` / `ivClassify_` / `ivTarget_` / Opportunity | `plProcess_` |
| `ivRefreshReview_` | 调用位置 | `Lead_Category__c` 信号(见 D-011) | `plRefreshReview_`(空操作桩) |

### DISABLE —— 原样移入 Legacy.gs(11 个)

`extractSender_` · `ivTop_` · `ivClassify_` · `ivContactMatch_` ·
`ivResolve_` · `ivExtract_` · `ivCreateCandidate_` · `ivTarget_` ·
`ivRecordReply_` · `ivProcess_` · `ivRefreshReview_`

逐条理由见 `src/Legacy.gs` 文件头。

**`ivTop_` 是计划评审时三分类表遗漏的一个** —— 它在 From/引用边界截断正文,
`PLENTI_ADAPTATION.md` 第 2 条明确警告这会截掉 Plenti 表单资料。它的消费者
(`ivClassify_` / `ivProcess_` / `ivRecordReply_`)全部是 DISABLE,按 ① 的
"无消费者即死代码"标准,它归 Legacy。补记于此。

### 隔离方式

Legacy 函数**保留原名**,不加前缀 —— 改名会破坏与 handoff 原件的 diff 可审计性。
隔离靠两件事:

1. `src/Legacy.gs` 文件头声明
2. **`test/offline.cjs` 的静态守卫**:读取三个文件的源码文本,断言
   `Code.gs` 与 `Plenti.gs` 去掉注释后不出现 Legacy.gs 定义的任何函数名。
   守卫自身有正反向自测(合成用例),并已对真实文件做过反向验证 ——
   往 `Plenti.gs` 注入一个 `ivTop_` 调用,套件确实变红。

另有一道 `test/offline.cjs` 检查:`Legacy.gs` 的每一行都必须按原顺序出现在
`docs/edocs-plenti-handoff/Code.gs` 里,保证它是原文。

---

## D-009 可信判定用严格版 dmarc=pass

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 2

`isPlentiSource_` 的判定顺序,任何一步不满足即 `trusted:false`,reason 写明
是哪一步失败:

1. `X-Original-Sender` 头存在且能解析出地址 —— **绝不回退到 `getFrom()`**
2. 该地址命中 `PLENTI_TRUSTED_SENDERS`
3. `X-Original-Authentication-Results` 头存在
4. 该头含 `dmarc=pass`,且若带 `header.from` 则域名与发件人域名一致

第 4 步只认 `dmarc=pass`,**不接受"`spf=pass` 或 `dkim=pass` 其一"**。
DMARC 通过意味着 SPF 或 DKIM 至少一项通过**且域名对齐**;单独的 `spf=pass`
可能只是转发链上某一跳的结果。

**fail-closed 的预期**:若 2026-09-09 样本显示 Plenti 没有 DMARC 记录、或用了
宽松对齐,所有邮件会落到 review —— 可见、不丢失,而且能从 reason 直接看出要调
哪一步。届时会**有意识地放宽并写进本文件**,不是默默改掉。这个预期也写在
`isPlentiSource_` 的函数注释里。

### `PLENTI_TRUSTED_SENDERS` 格式

逗号分隔,每项是完整地址 `user@domain` 或 `@domain`,大小写不敏感,
属性缺失或为空即抛错停止。

**匹配只用相等比较,不用 `indexOf` / `endsWith` 子串匹配** —— 否则
`@plenti.com.au` 会匹配到 `@evil-plenti.com.au`。`@domain` 条目只匹配该域名
本身,**子域名不自动可信**,要用就显式列进属性(放宽只需改配置,不必改代码)。
`testPlentiTrustedSenderBoundary` 用 10 条用例覆盖各种绕过尝试,其中两条是
前缀伪装(`evil-plenti.example`)和后缀伪装(`plenti.example.attacker.example`)。

---

## D-010 推广/招聘正则放在可信验证之后,且只细化 reason

**日期** 2026-09-07 · **决定人** Jack + Claude · **阶段** Phase 2

**位置**:推广、招聘、语音留言三段正则不在 `plExclude_`(阶段 A),而在
`plUntrustedReason_`,只跑在"发件人不可信"分支。

**为什么**:可信 Plenti 转介邮件的页脚极可能带营销话术。推广规则若在可信验证
之前跑,真转介会被判成 promotion 静默丢弃 —— 这是一条真实的漏单路径。放在
不可信分支下,它不可能误杀可信邮件。fixture `trusted-with-promo-footer.json`
就是为这条路径准备的。

**结论强度 —— 这一条与计划书里的括号说明不同,请注意**:计划评审时我写的是
"推广 → promotion 不打标签,和 info 一致;招聘 → review"。实现时改成了
**不可信邮件一律 review,`plUntrustedReason_` 只细化 reason 字符串**,
不再把推广判成静默 ignore。

改的理由有两条:

1. 静默丢弃与规格 §2 第二条可继承原则("认不出来转人工,**绝不静默丢弃**")
   直接冲突
2. Jack 对 Q10 的批复是"按规格实现,不放宽"。规格 §5.1 写的是"验证不通过
   → review",没有例外分支
3. 一封认证失败的**真** Plenti 转介,如果因为页脚营销话术被判 promotion,
   就是一条漏单 —— 而这恰恰是最需要人看的一封

代价是审核噪音更大,那正是 Q10 要用真实流量数据回答的问题。
**这是一处 fail-safe 方向的偏离,改回去只需要动 `plProcess_` 里的一个分支。**

---

## D-011 Plenti 不复用 `Lead_Category__c` 作为审核信号

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 2

`plLeadPayload_` 的 payload **不写** `Lead_Category__c`。

**为什么**(Jack 的三条理由):

1. **语义不符。** Plenti 转介按定义就是销售线索,模板那套
   "`Other` → `New Sales Enquiry`"映射不到"已审核"这个含义
2. **字段归属。** 这是 Lily 为 info 模型建的字段。两个邮箱往同一字段写不同
   语义,会同时污染两边的报表
3. **报表干净。** `LeadSource='Plenti'` 已经足够区分来源

**连带后果**:模板的 `ivRefreshReview_` 是 review 状态**唯一**的自动解除机制
(管理员改 `Lead_Category__c` → 脚本清 review → Gmail 标签消失)。不复用该字段
意味着 Phase 2 **没有替代方案**:

- `ivRefreshReview_` 进 Legacy
- 新建 `plRefreshReview_` 作为空操作桩:不改任何状态,直接返回。
  这样 `ivRefreshOutstanding_` 改调它之后仍能正常工作
- `SF-Lead-Review` 标签在 Phase 2 需要人工处理

真正的解除信号大概率应该是"Lead 被指派给跟进人",但那阻塞在 **Q1**。
记为 **Q9**。

---

## D-012 Lead Description 不复制邮件正文

**日期** 2026-09-07 · **决定人** Claude(需 Jack 追认) · **阶段** Phase 2

`plLeadPayload_` 的 Description 只写结构化摘要:邮件标记、referral ID、
来源邮箱、主题。**不复制邮件正文。**

**为什么**:模板把客户自由文本正文写进 Description(info 模型下那是全部信息)。
Plenti 转介邮件可能含融资申请资料与身份证明,`PLENTI_ADAPTATION.md` 第 11 条
要求"仅留存销售必要信息,不无条件保存整份融资申请/身份证明"。客户的姓名、
邮箱、电话、地址已经进了 Lead 的原生字段,正文的增量信息主要是敏感部分。

这是数据最小化方向的默认值,与 `ATTACH_RAW_EMAIL=false` 同一个理由。
若审核人反映上下文不够,那是 **Q5** 数据留存范围的一部分,由 Jack 拍板后再放开
—— 改一行即可。

**这一条计划书里没有,是实现时冒出来的决策点,请 Jack 追认。**

---

## 跨阶段待办(TODO)

### TODO-1 硬编码生产域名 → `INTERNAL_DOMAIN` 【✅ Phase 2 已完成】

**这是 D-001 的代价。已由 Phase 2 提交 `4654c1b` 处理。**

`src/Code.gs` 第 51 行(`ivClassify_` 内部邮件排除)硬编码了生产域名:

```javascript
if(!from||/@sunterra\.com\.au$/i.test(from))return {kind:'internal',top:top};
```

处理结果:该函数整体移入 `src/Legacy.gs`(原文保留),Plenti 路径改用
`src/Plenti.gs` 的 `plExclude_`,内部域名由 `ivInternalDomain_()` 读
Script Property `INTERNAL_DOMAIN`,**缺失即抛错停止**,符合规格 §3 禁止 #2。
离线测试 `testPlentiRequiredProperties` 覆盖缺失即抛错。

同类硬编码值的处置:

| 位置 | 硬编码值 | 处置 |
|---|---|---|
| `ivClassify_` L51 | `@sunterra.com.au` | ✅ 函数进 Legacy;主干改用 `INTERNAL_DOMAIN` |
| `ivAttachSource_` L129 | 文件标题 `'Info email '` | ✅ 改为 `'eDocs email '` |
| `ivCreateCandidate_` L115 | `Company:'Individual / Residential'` | ⏳ `plLeadPayload_` 按规格先写,注释标 **Q4** |
| `ivCreateCandidate_` L115 | `LeadSource:'Other'` | ✅ 主干写 `'Plenti'`,picklist 是否存在见 **Q3** |
| `ivReq_` L38 | API 版本 `v67.0` | 无需改,规格 §4 确认沿用 |

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

### TODO-3 `INTAKE_V2_START` 的两个 fail-open 缺口 【上线前必须处理,Q11】

Phase 2 写离线测试时发现,`runIntakeV2` 里这两行的组合有两个缺口:

```javascript
var began=Date.now(),cut=new Date(p.getProperty('INTAKE_V2_START')),cursor=new Date(p.getProperty('INTAKE_V2_WATERMARK')||cut.toISOString());
if(isNaN(cut.getTime())||isNaN(cursor.getTime()))throw new Error('Missing valid intake start/watermark');
```

1. **属性未设置 → 回扫到 1970。** `getProperty` 返回 `null`,`new Date(null)`
   得到 1970-01-01 而**不是** `NaN`,所以 `isNaN` 检查不触发。README 里
   `INTAKE_V2_START` 写的是"不自动回扫历史邮件",但代码没有强制这一点。
2. **属性是非法字符串 → 报错信息误导。** `cut.toISOString()` 在同一行先抛
   `RangeError: Invalid time value`,那句写好的
   `Missing valid intake start/watermark` 根本到不了。

那道 `isNaN` 检查实际上**只在 watermark 非法时可达**。

**都是 handoff 模板的既有行为,不是 Phase 2 引入的。** 没有顺手改,因为它超出
了 Jack 批准的函数三分类范围,而且属于"改模板既有逻辑"—— 按约定要先问。
两道安全开关关闭时不会触发,所以不是当前风险。

修法很短:`INTAKE_V2_START` 缺失或不可解析时直接抛错,与其他必填属性一致。
`test/offline.cjs` 刻意**没有**为这两个行为写断言 —— 测试不该把一个待修的行为
锁死成规范。

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

### Phase 2 新增(已实现,缺失即抛错停止)

| 属性 | 用途 |
|---|---|
| `INTERNAL_DOMAIN` | 内部邮件排除。取代模板里硬编码的生产域名(TODO-1 ✅)。填域名即可,带不带前导 `@` 都行 |
| `EDOCS_GROUP_ADDRESS` | 收信范围过滤(规格 §5.7)。检索串为 `list:<组地址> after:… before:… -in:spam -in:trash`。`list:` 匹配 Google Groups 写入的 `List-ID` 头 —— **操作符本身待 2026-09-09 样本验证**,`deliveredto:` 是备选 |
| `PLENTI_TRUSTED_SENDERS` | 可信 Plenti 发件地址 / 域(规格 §5.1)。格式见 D-009:逗号分隔,`user@domain` 或 `@domain`,子域名不自动可信。**具体填什么待样本确认** —— 拿到样本第一件事是打印全部邮件头,确认 Groups 是否保留了 `X-Original-Sender` 与 `X-Original-Authentication-Results` |
| `ATTACH_RAW_EMAIL` | 是否上传 `.eml` 原件到 Salesforce Files。**默认 `false`**,只有精确等于字符串 `'true'` 才开(规格 §5.6 / Q5)。这一项刻意**不抛错** —— 属性缺失即视为关闭,默认关闭才是安全方向 |

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
| Q9 | **review 状态如何自动解除?** 不复用 `Lead_Category__c`(D-011)后 Phase 2 没有替代信号,`plRefreshReview_` 是空操作桩,`SF-Lead-Review` 标签需人工处理。真正的信号大概率是"Lead 被指派给跟进人" | **阻塞于 Q1**,不是待样本 | D-011 |
| Q10 | **不可信邮件全部转 review 的审核噪音。** 进入 eDocs 群组的所有非 Plenti 邮件都会挂 Review 标签。按规格实现,不放宽;Jack 去问 eDocs 日均邮件量,**决策依据是真实流量数据,不是"感觉太吵"** | 上线前评估 | §5.1 / D-010 |
| Q11 | **`INTAKE_V2_START` 的两个 fail-open 缺口**(模板既有行为,Phase 2 发现但未改,详见下方 TODO-3) | 上线前 | —— |
