# eDocs Plenti Intake — 开发规格

**版本** 2026-09-07 · **负责人** Jack(Project Coordinator, Sunterra / Sola Now)
**给 Claude Code 的指令文档。先完整读完再动手。**

---

## 0. 一句话说明要建什么

一个**全新的、独立的** Google Apps Script 项目,读取 eDocs 群组投递到 `sf-intake@sunterra.com.au` 的邮件副本,识别其中来自 Plenti 的转介线索,在 Salesforce 建 Lead,并记录 SLA 所需的时间戳。

**它不是**对现有 info 邮箱项目的修改。info 那个项目继续独立运行,我们不碰它。

---

## 1. 背景:为什么每个约束都存在

Sunterra 与 Plenti(NAB 关联的持牌信贷机构)签了 Lead Referral Agreement。合同里有三条 SLA:

| 编号 | 要求 | 达标线 |
|---|---|---|
| PLT001 | 收到线索后 **1 个工作日内**尝试联系 | 每月 ≥ 90% |
| PLT002 | 线索到报价转化率 | 每月 ≥ 10% |
| PLT003 | 退出请求 **2 个工作日内**处理 | 100% |

**未达标 Plenti 可立即终止合同,没有补救期。** 另需每季度末后 10 个工作日内提交 Schedule 3 报告。

这决定了后面所有设计:时间戳必须可审计、数据必须可追溯、不确定的情况必须转人工而不是猜。

---

## 2. 参考代码从哪来

Lily Zhou(公司老板娘 / 财务负责人)交接了一个包:`edocs-plenti-handoff/`,内含 `Code.gs`、`Tests.gs`、`test-offline.cjs` 和两份说明文档。

**这是 info 邮箱那套生产系统的脱敏版模板,不是 Plenti 成品。** 它已去掉硬编码的生产域名和管理员 ID,加了安全锁。

**把它当作一次性模板,不是上游依赖。** 复制之后两边再无关系,不需要同步或合并。

### 从模板里要继承的三样东西

这三样与邮件格式无关,是踩坑攒出来的,直接移植:

1. **排除规则** — `ivClassify_` 前半段:内部邮件、Salesforce 自身通知、招聘求职、推广话术、自动回复/退信、测试邮件
2. **审核兜底原则** — 认不出来就返回 `review` 转人工,**绝不静默丢弃**
3. **创建前防重锁** — `Code.gs` 第 112 行:写 `IV2_CREATE_<msgId>` 属性,发现已存在就抛错要求人工核查,防止 API 超时后重复建 Lead

### 明确不要继承的

- `ivClassify_` 后半段的**购买意图猜测**(`purchase` / `product` / `fault` 三个布尔量)。那是为"客户自己写的自由文本"调的。Plenti 是结构化模板邮件,要按字段精确取值,不是猜意图。
- `extractSender_` **直接把发件人当客户**的逻辑。见 §5.2,这是最危险的一处。
- 模板文档里列出的一次性客户修复函数(`repairTeddySalesEnquiry` 等),包里已排除,不要重新引入。

---

## 3. 硬性禁止

违反任何一条都要停下来问 Jack。

1. **不修改 info 邮箱的 Apps Script 项目。** 不 clone、不 push、不读它的 Script Properties。
2. **不硬编码任何生产值** —— 域名、User ID、邮箱地址、Client ID/Secret 一律走 Script Properties,缺失就抛错停止。
3. **不自动启用。** `INTAKE_V2_ENABLED` 和 `EDOCS_ADAPTATION_VALIDATED` 默认 `false`,任一为 false 就不执行任何写操作。不写"验收通过后自动打开"的辅助函数。
4. **不在未验证发件人可信时建 Lead。** 见 §5.1。
5. **不把真实客户数据(尤其融资申请资料、身份证明)写进代码、测试或日志。** 测试一律用虚构数据。
6. **不默认上传 `.eml` 原始邮件到 Salesforce。** 见 §5.6。
7. **凭据不写进仓库。** `.gitignore` 必须排除任何含密钥的文件。

---

## 4. 环境与依赖

### 外部依赖(等待中,不阻塞地基开发)

| 依赖 | 来源 | 阻塞什么 |
|---|---|---|
| `sf-intake@sunterra.com.au` 账号+密码 | Workspace 管理员 | `clasp create`、创建触发器 |
| eDocs 组设置确认 | Workspace 管理员 | 端到端测试 |
| SF Client ID / Secret(新建,不复用 info) | Lily | 任何 Salesforce 调用 |
| Plenti 真实样本邮件 | 2026-09-09 会议 | 字段解析规则 |
| **Business Hours 修正** | Salesforce 配置 | **所有 SLA 计算** |

**关于 Business Hours**:当前 org 的 Business Hours 设成了 Los Angeles 时区 + 24/7。必须改为 Adelaide 时区、正确营业时间、并加入南澳公共假期。这是本项目之外的 Salesforce 配置任务,但**在它修好之前,任何"工作日"计算都是错的**。本项目只负责准确记录时间戳,不负责计算工作日差值。

### 技术栈

- Google Apps Script,V8 运行时,**ES5 风格 JavaScript**(与模板一致:只用 `var` 和 `function` 声明,不用箭头函数/`let`/`const`/`async`)
- 本地开发:`clasp` + git + VS Code
- 本地测试:Node.js,复用 `test-offline.cjs` 的 vm 沙箱模式
- Salesforce REST API v67.0

---

## 5. 关键设计决策(每条都有理由,不要自行推翻)

### 5.1 发件人可信验证 —— 优先级最高

Plenti 的邮件经过 Google Groups 转发。**如果 Plenti 域名设了严格 DMARC(`p=reject`),Groups 会改写 `From` 头为组地址。**

因此:
- **不能**用 `message.getFrom()` 判断来源
- **必须**读 `message.getHeader('X-Original-Sender')` 取真实发件人
- **必须**读 `message.getHeader('X-Original-Authentication-Results')` 判断 SPF/DKIM 是否通过
- 显示名称含 "Plenti"、主题含 "Plenti"、正文声称来自 Plenti —— **都不构成可信证据**
- 验证不通过 → `review`,不建 Lead

**这一条必须用真实样本验证,不能假设 Groups 一定保留了这些头。** 拿到样本后第一件事就是打印全部邮件头确认。

### 5.2 客户身份 ≠ 发件人

模板的 `extractSender_` 把发件人邮箱当作 `Lead.Email`。**在转介模型下这是错的**:会把 Plenti 的地址(或被改写后的组地址)写成客户邮箱,导致所有 Plenti 线索因邮箱相同而互相错误匹配。

Plenti 路径必须从**邮件正文的明确字段**提取客户姓名、邮箱、电话、安装地址。供应商签名、服务热线不得作为客户信息。字段缺失或出现多个候选 → `review`,**不用 Plenti 邮箱兜底创建**。

### 5.3 SLA 时间戳

**新建自定义字段 `Plenti_Received_At__c`(DateTime),值取 `message.getDate()`。**

PLT001 全部按此字段计算,**不用 `CreatedDate`**。因为 Apps Script 是定时轮询(建议 10–15 分钟),Lead 创建时间会晚于实际接收时间,而且模板第 200 行的逻辑是"有 error 未清理则 watermark 不前移",延迟可能被放大。

字段命名需先与 Jack 确认,并检查 org 中是否已有可复用字段。**脚本不自动创建 Salesforce 字段。**

### 5.4 业务去重

三层,缺一不可:

| 层级 | 手段 | 防什么 |
|---|---|---|
| 邮件级 | `IV2_MSG_<gmailId>` 状态 | 同一封邮件重复处理 |
| 创建级 | `IV2_CREATE_<gmailId>` 防重锁 | API 超时后重复建 Lead |
| **业务级** | **Plenti referral / application ID** | **同一转介被重发成新邮件** |

第三层是模板没有的,**必须新增**。Gmail ID 只能防同一封邮件,防不住 Plenti 重发。referral ID 存哪里(Lead 自定义字段 vs Script Properties)等看到样本确认 ID 格式后再定 —— 倾向**存 Lead 字段**,因为 Script Properties 有 500KB 上限且不可靠。

**同一 referral ID 的补充资料应更新已有 Lead,不是拒绝。** 客户相同但明显是新项目 → `review`,不自动合并。

### 5.5 跨邮箱去重

info 项目和本项目写入同一个 Salesforce,互不知情。同一客户可能两边都进来。

**缓解措施**:建 Lead 前查询同邮箱的活跃 Lead,发现即转 `review`。模板 `ivResolve_`(第 96 行)已是此逻辑,照抄。

这不是完备方案(两个项目的锁无法跨项目原子操作),但能挡住绝大多数情况。**在文档里明确记录这是已知限制。**

### 5.6 数据留存 —— 需要决策,默认关闭

模板会把整封原始邮件连同全部附件以 `.eml` 上传到 Salesforce Files。

Plenti 转介邮件很可能包含**融资申请资料和身份证明**。无条件全量留存需要业务/合规层面拍板,不是技术决定。

**实现要求**:做成可配置开关 `ATTACH_RAW_EMAIL`,**默认 `false`**。代码路径写好但不启用,等 Jack 确认允许的数据范围后再开。

### 5.7 收信范围

模板第 197 行扫的是整个收件箱,没有来源限制。**必须收窄:**

```
list:edocs@sunterra.com.au after:<ts> before:<ts> -in:spam -in:trash
```

`list:` 匹配 Google Groups 写入的 `List-ID` 头,是最可靠的过滤方式。**具体操作符待样本验证**,`deliveredto:` 作为备选。组地址走 Script Properties(`EDOCS_GROUP_ADDRESS`),不硬编码。

### 5.8 业务边界

**只有真实销售转介才建 Lead。** 放款通知、文件处理、安装排期、售后、推广 —— 即使来自 Plenti,也不建 Lead。

解析不确定的 → 可见的审核路径,**不静默丢弃**。

### 5.9 Lead 字段映射

| 字段 | 值 | 注意 |
|---|---|---|
| `LeadSource` | `Plenti` | **先确认 picklist 有此值**,没有要先加(Setup 操作,不由脚本做) |
| `Plenti_Received_At__c` | `message.getDate()` | 新建字段,见 §5.3 |
| `Contact_Attempt_Count__c` | `0` | 复用 Lily 已建字段 |
| `OwnerId` | `INTAKE_ADMIN_ID` | 见下方警告 |
| `Email` | **客户**邮箱 | 见 §5.2 |
| `Company` | 待定 | 模板写死 `Individual / Residential`,需确认是否适用 |

**⚠️ Owner 问题**:模板把新 Lead 全部指派给审核管理员。这意味着 **SLA 时钟开始跑,但没有人被分配去联系客户**。目前 Plenti 线索的跟进人尚未确定(Graham Bottomley 出现过但角色未定义)。

**这是业务未决项,不是代码问题。** 先按 `INTAKE_ADMIN_ID` 实现,但在 README 中显著标注此风险。

### 5.10 Lead-only 边界

模板包含"已转换 Lead → 写入 Opportunity"的分支。**本项目只做 Lead,必须禁用该路径。**
模板的"老客户在 Account 上建 Completed Task"分支同样默认关闭,待 Jack 决定。

---

## 6. 分阶段实施

### Phase 1 — 本地地基(无外部依赖,立即开始)

```
edocs-plenti-intake/
├── .clasp.json          # gitignore
├── .gitignore
├── appsscript.json
├── src/
│   ├── Code.gs          # 主流程(移植自模板)
│   ├── Plenti.gs        # Plenti 专用解析(新)
│   └── Tests.gs         # 回归测试
├── test/
│   ├── offline.cjs      # 沙箱测试入口
│   └── fixtures/        # 虚构样本邮件
├── docs/
│   └── DECISIONS.md     # 决策记录
└── README.md
```

任务:
1. `git init`,把模板包的 `Code.gs` / `Tests.gs` / `test-offline.cjs` 作为初始 commit,commit message 注明来源与日期
2. 建立上述目录结构
3. `.gitignore` 排除 `.clasp.json`、`*.local.json`、任何含密钥的文件
4. 确认 `node test/offline.cjs` 全部通过(基线:11 分类 + 2 字段提取 + 3 边界 + 8 标签 + 6 短询问 + 6 购买意图 + 3 回复地址 + 多行地址 + 6 去重 + 安全门槛)
5. `appsscript.json` 时区设为 `Australia/Adelaide`

### Phase 2 — 移植三样可继承的东西(无外部依赖)

1. 排除规则:内部 / SF 通知 / 招聘 / 推广 / 自动回复 / 测试邮件
2. `review` 兜底原则贯穿所有分支
3. 创建前防重锁

**每一条都要有对应的离线测试。** 移植时保留模板里那两个"擦除"补丁(`no issues with...` 和 `website ... didn't work`),它们是防误判的。

### Phase 3 — Plenti 解析骨架(无样本也能做)

在 `Plenti.gs` 中定义接口,**解析实现留 TODO**:

```
isPlentiSource_(message)      → {trusted: bool, reason: string}
parsePlentiReferral_(message) → {referralId, customer:{...}, kind, confidence}
```

- `isPlentiSource_` 按 §5.1 实现,现在就能写
- `parsePlentiReferral_` 的**字段提取正则留空**,但错误处理、缺字段转 review、置信度判断的框架现在写好
- 在 `ivProcess_` 之前插入 Plenti 分流:命中 Plenti 路径就完全绕开 `ivClassify_` 的意图猜测

用**虚构的**结构化邮件 fixture 测试框架逻辑。真实样本到手后只需填正则。

### Phase 4 — 需要凭据后

1. `testSalesforceClientCredentials()` 连**沙箱**(不是生产)
2. 字段映射验证:确认 `LeadSource` picklist、`Plenti_Received_At__c` 存在
3. 沙箱端到端:收信 → 建 Lead → 补录 → 标签
4. 逐条跑 §7 验收用例
5. 全部通过后,由 Jack 手动开启两个安全开关,设置触发器(**必须用 `sf-intake` 账号登录创建**)

---

## 7. 验收用例

上线前必须全部通过。

| 场景 | 期望结果 |
|---|---|
| 可信 Plenti 新转介 | 建一个 Lead;Email 是**客户**的;`LeadSource=Plenti`;`Plenti_Received_At__c` 等于邮件时间 |
| 同一封邮件跑两次 | 不重复建 Lead、不重复追加 Description、不重复上传文件 |
| 同一 referral ID 换新邮件重发 | 不建第二个 Lead |
| 同一转介补充电话/地址 | 更新原 Lead;冲突字段不覆盖,转 review |
| 同一客户邮箱但不同项目 | 不自动合并,转 review |
| info 与 eDocs 同时收到同一客户 | 转 review,不产生竞态重复 |
| **伪造 Plenti**(显示名/主题含 Plenti,但 `X-Original-Authentication-Results` 未通过) | **不建 Lead** |
| Plenti 发来的推广/售后/文件状态通知 | 不建 Lead |
| API 写入成功但打标签失败 | 恢复时只补标签,不重复建记录 |
| API 超时结果不确定 | 先查 referral ID 是否已存在,不盲目重建 |
| 解析缺字段 / 正文超长 / 含敏感附件 | 明确异常、可见审核、不泄露不丢失 |
| 两个安全开关任一为 false | 不执行任何写操作 |
| 触发器执行身份 | 只读取 `sf-intake` 的邮箱 |

---

## 8. 交给 Claude Code 的第一步

从 Phase 1 开始。**先输出一份实施计划让 Jack 确认,再动手写代码。**

遇到以下情况停下来问,不要自行决定:
- 任何需要修改 Salesforce 配置的地方(字段、picklist、Flow)
- 任何涉及数据留存范围的判断
- 任何 §3 禁止事项的边界情况
- 模板代码里看不懂用途的逻辑(很可能是踩坑补丁,别删)

---

## 9. 已知限制(写进 README,不要试图在本期解决)

- 正则匹配不是语义理解,没见过的格式会落到 review
- 跨项目(info / eDocs)无法原子去重
- Script Properties 有 500KB 上限,长期运行需迁移到外部状态存储
- Apps Script 锁只保护单项目,不保证跨系统 exactly-once
- Description 上限 32,000 字符,超出报错
- 本脚本不发送首次回应邮件;Salesforce 既有自动回复和 Flow 可能被创建动作触发,需单独验证
