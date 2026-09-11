# eDocs Plenti Intake

读取 eDocs 群组投递到 `sf-intake@sunterra.com.au` 的邮件副本,识别其中来自
Plenti 的转介线索,在 Salesforce 建 Lead,并记录 SLA 所需的时间戳。

一个**全新的、独立的** Google Apps Script 项目。**它不是**对现有 info 邮箱
项目的修改 —— info 那个项目继续独立运行,本项目不碰它。

完整规格见 [docs/eDocs-Plenti-Intake-开发规格.md](docs/eDocs-Plenti-Intake-开发规格.md)。
决策记录与待办见 [docs/DECISIONS.md](docs/DECISIONS.md)。
Salesforce 沙箱配置手册见 [docs/SANDBOX_SETUP.md](docs/SANDBOX_SETUP.md)(Jack 手工执行,同时是照搬到生产的清单)。

---

## 当前状态:Phase 2 完成 —— 不可上线

**定位**(DECISIONS D-007):`src/Plenti.gs` 是主干,本项目只处理 Plenti
转介线索;`src/Code.gs` 是基础设施工具库;`src/Legacy.gs` 隔离 info 模型
专有逻辑,主干一次也不引用它(由离线测试的静态守卫强制检查)。

已完成:

- 仓库、目录结构、`.gitignore`、`appsscript.json`(Phase 1)
- 模板函数三分类,info 专有逻辑隔离进 `Legacy.gs`(D-008)
- 发件人可信验证 `isPlentiSource_`(规格 §5.1)
- 三样可继承的东西:排除规则、`review` 兜底、创建前防重锁(规格 §2)
- 解析骨架 `parsePlentiReferral_`,**字段正则留空**
- 收信范围收窄到 eDocs 群组(规格 §5.7)
- `.eml` 留存开关,默认关闭(规格 §5.6)

### ⚠️ 数据源是 browser view 页面,不是邮件正文(D-019)

2026-09-09 实测确认:**Plenti 邮件正文的客户字段是空的**(Lily 直接收到的
原件也一样)。Plenti 是上市金融机构,让他们改模板不现实,我们只能自适应。

**邮件只负责两件事:触发处理,提供 View in Browser 链接。** 真实数据由脚本
抓取该链接指向的页面得到 —— 纯静态页,不需要 cookie、不需要执行 JS。

**2026-09-11 更新(D-029)**:正式 lead 的**邮件正文里也有数据了**,并且多了
`Customer phone`。现在两个来源都解析、逐字段合并:冲突时**以邮件为准**并标记出来,
页面补齐邮件缺的字段。页面**永远照抓** —— 它是审计留底,也是唯一的交叉核对。

字段:客户姓名 / **客户电话** / 客户地址 / 可再生系统。**仍然没有客户邮箱**,
所以 Lead 上不会有 `Email` —— 这不是缺陷,是数据源就没有。电话按号段分流:
`04` 开头进 `MobilePhone`,其余进 `Phone`,原样写入不规范化。

**尚未完成**:

- **组投递识别与发件人可信验证尚未验证**。eDocs 组还没建好,拿不到经过组投递
  的邮件:`list:<组地址>` 查询、`X-Original-Sender` 与
  `X-Original-Authentication-Results` 这三样都没有真实样本可测。
  其余环节靠 `plTestFromMessageId` 这个**临时**测试入口验证(D-020),
  配合 `PLENTI_TEST_SENDER_OVERRIDE` 伪造身份头(D-021)。
  ⚠️ **开着那个属性时规格 §5.1 的可信验证整个是假的** —— 它是本项目安全性
  最关键的控制,进组之后必须单独补测,不能因为测试通过就认为它验证过了。
  两者都在 Phase 4 后删除。
- **`Plenti_Received_At__c` 在生产上尚未建出来**(D-023)。沙箱已建并写入。
  代码会用 describe 探测该字段是否存在:**不存在就跳过,不会阻断建 Lead**,
  收件时间仍留在 `Plenti_Parsed_JSON__c` 的 `receivedAt` 里。但在生产建好
  之前,**PLT001 SLA 无法从专用字段统计**(规格 §5.3 要求按该字段计算而非
  `CreatedDate`)。
- **任务 B upsert**(D-013)。当前是 `POST` + 事前 SOQL 查重,尚未切到
  `PATCH /sobjects/Lead/Plenti_Lead_ID__c/{token}`
- **补充资料更新已有 Lead 的路径**。`kind==='supplement'` 目前只转 review
- **review 状态的自动解除**(Q9,阻塞于 Q1)。`plRefreshReview_` 是空操作桩,
  `SF-Lead-Review` 标签需人工处理
- 任何 Salesforce 连接与字段映射验证(Phase 4)

⚠️ `isPlentiSource_` 的实现**必须用 2026-09-09 拿到的真实样本验证**。不能假设
Google Groups 一定保留了 `X-Original-Sender` 和 `X-Original-Authentication-Results`
这两个头。拿到样本第一件事是打印全部邮件头确认。

---

## 🔴 运维须知 —— 开触发器前必读

### 1. error 没人处理,整条流程会慢性死亡

这个因果关系不直观,所以放在最前面:

```
一封邮件落 error
  → watermark 冻结(只有"整轮扫完且无 error"才推进)
  → 扫描窗口的下界停在原处,窗口外噪音状态的清理也跟着停
  → 每封新到的噪音邮件都在 Script Properties 里多占一格,不再释放
  → 写满 500 KB
  → 所有写入失败 —— 包括 referral,整条管道停摆
```

**丢的不只是那一封邮件,是之后所有的邮件。** 倒计时:

```
还剩几个工作日 ≈ (500 KB − 当前用量) ÷ 约 20 KB
```

上线初期约 **24 个工作日**;但永久状态会一直累积(Q19),**半年后可能只剩 9 天左右**。

**怎么发现:** 运行日志 Sheet 汇总页的 `Failures` 列**连续多轮非零** = watermark 已冻结,
倒计时在走。错误摘要列里有消息 ID。处理方式见 DECISIONS L-01。

### 2. 触发器:用收件邮箱那个账号建,失败通知设为「立即通知」

⚠️ **触发器以创建者身份运行,`GmailApp` 读的是创建者自己的邮箱。** 必须用接收组邮件
的那个账号来建,失败通知也会发到这个账号 —— 确认有人看它(D-040 ⑤)。


建时间驱动触发器时,Failure notification 选**立即**(默认是每日汇总)。
Script Properties 真的写满时,**error 状态本身都写不进去**,`Failures` 列不会亮,
汇总页只是**不再出现新行** —— 唯一及时的信号是执行失败通知(D-034)。

⚠️ **汇总页"安静"不等于健康。** 如果本该有邮件的时段汇总页没有新行,先去看
Apps Script 的执行记录。

### 3. 不要手工回拨或删除 `INTAKE_V2_WATERMARK`

窗口外的噪音状态已被清理,回拨会让那些邮件被重新处理,Messages 表重复写行(D-032)。
`IV2_MSG_*` 的数量随时间**减少**是清理在工作,不是数据丢失。

### 4. 永久状态的长期累积(Q19)

每条建出的 Lead 永久占约 472 字节。按每天 5 条 referral(只来自 2 小时样本)估,
约 **9 个月**写满,表现是上面第 2 条那种**静默停摆**。准备工作按**用量**触发,
不按日期 —— 用量到 60%(300 KB)之前要做完 D-034 ④ 的清理扩展。
应急手段必须提前备好:Script Properties 界面只能逐个删键,几百个键手工删不现实。

---

## 谁跟进新建的 Lead:生产 Round Robin(D-035 / D-038)

~~模板逻辑把新建 Lead 全部指派给审核管理员 `INTAKE_ADMIN_ID`~~ —— **已改。**
生产的 Active Flow **New Sales Lead Round Robin** 六人轮值分派 Owner,代码配合它的
进入条件:

| 进入条件 | 代码怎么满足 |
|---|---|
| `Status = New` | payload 写 `New` |
| `Lead_Category__c = New Sales Enquiry` | 写 `PLENTI_LEAD_CATEGORY`;写不上就落 `[NOT ROUTED]` review |
| `OwnerId` 是 Lily 的账号 | **不设 OwnerId**,默认等于运行用户 —— 集成用户就是 Lily |
| `CreatedById` 是 Lily 的账号 | 同上,记录由运行用户创建 |

⚠️ **不要给 payload 加 `OwnerId`。** 设成任何人,Round Robin 都会直接不跑。
主干不再读 `INTAKE_ADMIN_ID`,可以清空。

⚠️⚠️ **分派依赖 Lily 的个人账号。** Round Robin 的条件里写死了她的两个 User ID,
而集成就以她的身份运行。**她的账号停用,或者将来把集成换成专用用户,Round Robin
都会静默停止分派 Plenti 的 Lead** —— 而且代码的 `[NOT ROUTED]` 查不出来(分类照样
写上了)。换人之前必须先改 Flow 的条件。见 D-038。

---

## ⚠️ 运行日志 Sheet 含 PII —— 分享设置必须限制为指定人员

`INTAKE_LOG_SHEET_ID` 指向的 Google Sheet 有两个标签页:

| 标签页 | 内容 |
|---|---|
| 第一页(汇总) | 每轮执行一行:时间、线程数、处理数、建 Lead 数、失败数、错误摘要、耗时 |
| `Messages` | **每封邮件一行,含完整邮件正文** |

**`Messages` 页会包含真实客户的姓名、邮箱、电话、安装地址,以及邮件原文里
的任何其他内容。**

因此:

- ❌ **绝不可设为「知道链接的人可查看」**(anyone with the link)
- ❌ 不可设为对整个域可见
- ✅ 分享设置必须限制为**逐个指定的人员**
- ✅ Sheet ID 本身不写进本仓库,只放 Script Properties

这张表存在的理由是排查和调解析正则(Apps Script 日志保留期短),
**不是长期客户数据仓库**。解析规则稳定之后应当评估保留期与清理策略 ——
这一条和 Q5(数据留存范围)是同一个问题。

---

## 安全开关:两道锁,默认全关

`runIntakeV2()` 在任何 Gmail / Salesforce 调用之前检查两个 Script Property,
任一为 `false` 就不执行任何写操作:

| 属性 | 默认 | 含义 |
|---|---|---|
| `INTAKE_V2_ENABLED` | `false` | 上线开关。为 false 时直接返回 |
| `EDOCS_ADAPTATION_VALIDATED` | `false` | 交接安全锁。为 false 时抛错 |

第二把锁**不是**自动检测 Plenti 适配是否完成,只是一道人工闸门 ——
只有负责人逐条验收(规格 §7)之后才手动改为 true。

本仓库**不提供**任何"验收通过后自动打开"的辅助函数。
`enableIntakeV2AfterValidation()` 被有意实现为直接抛错。

---

## 字段自检 —— 改字段映射或切生产前先跑

```
plTestDescribeLead()
```

取 Salesforce 的 Lead describe,和代码实际用到的字段比对,列出「代码要用但
这个 org 里没有」的字段。只读,不写任何记录。

⚠️ **Salesforce 是全有全无:一个字段不存在,整个请求就失败。** 这类错误的
表现是运行时 400,排查成本高 —— 切生产之前务必先跑一次,生产的字段和沙箱
不一定一样(D-022)。

离线测试里还有一道对应的守卫:代码触及的自定义字段必须**恰好等于**已确认
存在的那五个,多一个就红。

---

## 本地测试

无任何 npm 依赖,只用 Node 内置模块(`node:vm`、`node:assert`)。

```bash
node test/offline.cjs
```

测试在 `node:vm` 沙箱中加载 `src/Code.gs` 与 `src/Tests.gs`,
`UrlFetchApp.fetch` 被替换为直接抛错的桩 —— **测试不会连接 Gmail 或
Salesforce,不会读写任何真实记录**。

测试内容分三层:

1. **静态守卫** —— 断言 `Code.gs` / `Plenti.gs` 去掉注释后不出现 `Legacy.gs`
   定义的任何函数名,并断言 `Legacy.gs` 的每一行都按原顺序出现在 handoff
   原件里。Apps Script 是单一全局作用域,文件头声明靠人自觉,这道检查是强制的。
   守卫自身带正反向自测。
2. **模板基线** —— 规格 §6 Phase 1 第 4 项列出的那些用例,一条不少:
   11 分类 + 2 字段提取 + 3 边界 + 8 标签 + 6 短询问 + 6 购买意图 +
   3 回复地址 + 多行地址 + 6 去重 + 安全门槛。
3. **Plenti 路径** —— 可信验证、域名边界绕过、排除规则、空发件人、解析骨架、
   fail-closed 去重、防重锁、字段映射、`.eml` 开关、端到端分流。

> 输出中 `8 Lead-only label cases` 出现两次,是 `testPurchaseIntentUpgrade`
> 与 `testMultilineReplyRepair` 各自嵌套调用了一次 `testLeadOnlyLabels()`,
> 不是多出来的测试用例。

---

## 目录结构

```
├── appsscript.json       Apps Script manifest(时区 Australia/Adelaide)
├── .clasp.json           本地生成,已 gitignore,Phase 4 才创建
├── src/
│   ├── Plenti.gs         **主干** —— plProcess_ 及全部 Plenti 逻辑
│   ├── Code.gs           基础设施工具库(SF REST / 属性 / 状态 / 标签 / 定时入口)
│   ├── Legacy.gs         info 模型专有逻辑,原文隔离,主干不引用
│   ├── Tests.gs          模板回归测试(原文未改,兼作 Legacy 未被改动的守卫)
│   └── PlentiTests.gs    Plenti 路径回归测试
├── test/
│   ├── offline.cjs       沙箱测试入口 + 静态守卫
│   └── fixtures/         虚构样本邮件 .json(规则见该目录 README)
└── docs/
    ├── eDocs-Plenti-Intake-开发规格.md   项目规格
    ├── DECISIONS.md                      决策记录与待办
    └── edocs-plenti-handoff/             Lily 交接的参考包(冻结,不再同步)
```

`docs/edocs-plenti-handoff/` 是**一次性模板**,复制之后两边再无关系。
保留在仓库内仅供 diff 比对,**不是上游依赖**,不需要同步或合并。

---

## Script Properties

所有环境相关值一律走 Script Properties,**代码中不硬编码**,缺失即抛错停止。
Phase 2 新增四项:`INTERNAL_DOMAIN`、`EDOCS_GROUP_ADDRESS`、
`PLENTI_TRUSTED_SENDERS`、`ATTACH_RAW_EMAIL`(默认关闭)。
完整清单与格式说明见 [docs/DECISIONS.md](docs/DECISIONS.md)。

⚠️ **`PLENTI_LEAD_CATEGORY`(D-035)决定 Lead 有没有人跟进。** 生产的 Round Robin Flow
按 `Lead_Category__c = New Sales Enquiry` 分派 Owner。值必须与活跃 picklist 值完全一致;
集成用户还必须有该字段的编辑权限,否则 Lead 照建但落 `[NOT ROUTED]` review、没人被分派。

凭据**不写进仓库**,只通过获准的安全方式配置,不发在聊天或邮件中。

---

## OAuth Scopes

`appsscript.json` 声明三个 scope:

| Scope | 用途 |
|---|---|
| `https://mail.google.com/` | GmailApp:读邮件、加标签 |
| `.../auth/script.external_request` | UrlFetchApp:调 Salesforce REST API |
| `.../auth/script.storage` | PropertiesService:去重与处理状态 |
| `.../auth/spreadsheets` | SpreadsheetApp:运行日志与消息级日志(D-016 / D-018)|

⚠️ `spreadsheets` 是 R2 新加的 scope。**加 scope 会使现有授权失效,Apps Script
会要求重新授权。**

`https://mail.google.com/` 是 Gmail 的**完全权限**(读 + 写 + 删),而本项目
实际只需要读邮件和加标签。**这个 scope 大概率收不窄** —— Apps Script 的内置
GmailApp 服务就是绑定该 scope 的,要收窄基本得改用 Gmail 高级服务直接调
REST API,那是另一套写法、另一次重写。Phase 4 会实测确认,但不要按"能收窄"
来规划。

因此:**必须使用专用账号(`sf-intake`),并由 Workspace 管理员审核授权。**
触发器必须用 `sf-intake` 账号登录创建 —— GmailApp 操作的是**实际执行用户**
的邮箱,不由 `INTAKE_MAILBOX` 属性决定,该属性只是记录来源文字。

---

## 已知限制(规格 §9,本期不解决)

- 规则是**正则匹配,不是语义理解**。没见过的邮件格式会落到 review,
  不会被静默丢弃,但也不会被自动处理。
- **跨项目无法原子去重。** info 与 eDocs 两个 Apps Script 项目写入同一个
  Salesforce,彼此的 Properties、锁和 Gmail ID 互不可见。建 Lead 前查询
  同邮箱活跃 Lead 只能挡住绝大多数情况,不是完备方案。
- **Script Properties 有 500KB 上限**,长期运行需迁移到外部状态存储。
- **Apps Script 锁只保护单项目**,不保证跨系统 exactly-once。标签失败、
  文件失败、Lead 已写入等中间状态必须逐一测试。
- **Lead Description 上限 32,000 字符**,超出报错。
- **本脚本不发送首次回应邮件。** Salesforce 既有的自动回复、分配和其他
  Flow 可能被创建动作触发,需单独验证。
- **`review` = 脚本需要人帮忙**(Q18 / D-033)。干净建出的 referral 直接 `done`,
  只亮 `SF-Lead-Created`;**"待补联系方式"看 Salesforce List View,不看 Gmail 标签。**
  `SF-Lead-Review` 只在例外时亮:降级(没解析出姓名)、邮件与页面说法不一、
  转介重发(token 命中别的邮件建的 Lead)、强制创建、带链接的可疑发件人、error。
  例外的 review 在 Lead 上出现人填的联系方式、被转换或标为 Unqualified 后自动解除。
- **Messages 表**:SF Lead ID 列是可点的链接(写入时生成);`Final state` 列里
  `created + review` 表示建出了 Lead 但需要人看。以 `= + - @` 开头的内容一律按文本
  存,防公式注入(D-033)。
- 并非每条 review 都对应一条 Salesforce 记录 —— `SF-Lead-Review` 标签既
  可能是已创建的待审核 Lead,也可能是尚未唯一匹配的邮件。
- **`SF-Lead-Review` 标签只留给带 Plenti browser-view 链接的邮件**(D-027)。
  没有链接的普通业务邮件落 `done` 状态(Q18 前是 review)、在 Messages 表里留一整行
  (含完整正文和原因),但**不占标签** —— 否则进组当天真正的 lead 会被业务邮件淹掉。
  可见面从 Gmail 标签移到 Messages 表,可见性本身没有降低。
- **手动转发的 Plenti 邮件会被单独标为 `forwarded`**,不会被当成疑似伪造。
  判据是**没有 `X-Original-Sender`**(D-030)—— 不能看 `From`:发件域 DMARC
  `p=REJECT` 时 Google Groups 会把 `From` 改写成组地址,组投递的邮件 `From`
  永远在内部域上。该区分**只影响 reason 措辞,不影响是否打标签**。
- ⚠️ **`PLENTI_TRUSTED_SENDERS` 必须填精确的 referral 发信地址,不能填整个
  `@plenti.com.au` 域**(D-030)。Plenti 有多条业务线往 eDocs 发信,填整个域的话,
  其他业务线的邮件只要带 Customer.io 链接就会**建出垃圾 Lead**。发件人不在清单
  里时,reason 会原样打出该地址,告诉你该往清单里加什么。
- **`SF-Lead-Updated` 在 Plenti 路径上永远不亮**(D-024)。它唯一的触发条件
  `verifiedFields` 只有 `Legacy.gs` 里的回复补录逻辑会写,而主干不调用它。
- **Plenti 不提供任何联系方式**,电话和邮箱只在 Plenti Portal 里,而 Portal
  每次登录都要双重验证、账号是个人账号,无法自动化。因此**每一条 Plenti 线索
  都必须有人去 Portal 取联系方式**,这是必经状态而非边缘情况(D-024)。
  Q18 之后这个工作队列在 Salesforce List View 里,不再占用 review。
- `INTAKE_V2_START` 必须配置且可解析,否则 `runIntakeV2` 直接抛错停止 ——
  脚本**不会**在缺配置时回扫历史邮件(DECISIONS TODO-3 修复了模板的这个缺口)。
- ✅ ~~Script Properties 约 6 个工作日就会写满~~(L-04)**已由 D-032 解除**:
  主循环只处理扫描窗口内的消息;噪音状态只存约 75 字节;窗口外的噪音状态每轮清理。
  正常运行稳定在约 35 KB。**error 未处理时仍会写满,见顶部「运维须知」。**
- **所有 referral 都会被 Gmail 合进同一个会话**(D-031)。Gmail 标签按会话打,
  **表示不了单条 referral 的状态**。单条状态以 Salesforce 为准。
- **人工先建、程序后建会产生重复 Lead,无法自动识别**(L-05)。程序的去重只认得
  程序自己建的 Lead(delivery token 字段、消息 marker),人工建的都没有。管道上线后
  Plenti 的 referral 不要再手工建。清理重复时**只删 Salesforce 里的 Lead,不要删
  对应的 `IV2_MSG_*` / `IV2_CREATE_*`**,否则那封邮件会被再建一次。
- **跨邮箱去重在 Plenti 路径上实际失效**(Q15)。规格 §5.5 那一层靠客户邮箱
  查询,而 Plenti 从不提供客户邮箱。info 与 eDocs 同时收到同一客户时不再能
  自动拦截,只能靠人工审核兜住。
- **抓取失败建出的降级 Lead 不会被自动补齐**(D-028)。一次网络抖动就会让这条
  Lead 永久缺姓名、地址、systems 和审计留底 HTML —— 下一轮扫描不会重试,
  除非有人手动 force 重跑。**不影响 SLA、不漏单**(Lead 照建),是数据质量问题。
- **browser view 链接可能有有效期。** 抓取时间戳记在 `Plenti_Parsed_JSON__c`
  的 `browserView.fetchedAt`;抓取失败时 Lead 照建并标记 `[DEGRADED]`,
  人工可以自己点邮件里的链接查看。
- **收件人白名单不命中的邮件不留任何痕迹**(D-015)—— 不写状态、不打标签。
  这是范围过滤,与 `list:` 查询同一性质,不是"静默丢弃"分类不确定的邮件。
  若日后把某地址移出白名单,相关 thread 的旧标签不会自动清除。
- **邮件正文这一轮不做任何清洗**(D-018)。`plCleanBody_` 是纯透传占位:
  Plenti 的邮件格式 2026-09-09 才第一次见到,此刻写的清洗规则都是猜的。
  回落到 HTML 时标签原样保留,不剥。
- **`IV2_CREATE_` 防重锁不回滚**(DECISIONS L-01):任何 Salesforce 写入失败
  ——包括明摆着可重试的 500——都需要人工去 Script Properties 删键才能继续,
  且会冻结 watermark 造成渐进劣化。
- **Business Hours 当前配置错误**(Los Angeles 时区 + 24/7),必须改为
  Adelaide 时区、正确营业时间并加入南澳公共假期。这是本项目之外的
  Salesforce 配置任务,但**在它修好之前任何"工作日"计算都是错的**。
  本项目只负责准确记录时间戳,不负责计算工作日差值。

---

## 停用

需要停止时:将本项目 `INTAKE_V2_ENABLED` 设为 `false`,并停用本项目触发器。
**不要改 info 项目。**

保留状态属性及已创建记录,先核对"API 成功但标签失败"等中间状态再重试。
`IV2_MSG_*`、`IV2_CREATE_*`、`IV2_REF_*` 参与去重和失败恢复,
**不要通过删除全部状态来强制重跑历史邮箱。**
