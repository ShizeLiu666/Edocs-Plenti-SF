/**
 * Plenti.gs —— 本项目主干(DECISIONS D-007)。
 *
 * 本项目只处理 Plenti 转介线索,不处理客户直接询价。定时入口
 * runIntakeV2(Code.gs)对每封邮件调用本文件的 plProcess_。
 *
 * 与模板的关系:src/Code.gs 是基础设施工具库,本文件调用它;
 * src/Legacy.gs 是 info 模型专有逻辑,本文件**一次也不引用**
 * (由 test/offline.cjs 的静态守卫强制检查)。
 *
 * 代码风格:Apps Script V8 运行时,ES5 —— 只用 var 和 function 声明,
 * 不用箭头函数 / let / const / async,与 Code.gs 一致。
 *
 * ┌─ plProcess_ 分流顺序 ────────────────────────────────────────┐
 * │ A. plExclude_          与可信无关的排除(不需要正文)          │
 * │ B. isPlentiSource_     发件人可信验证(规格 §5.1)             │
 * │      不可信 → review,plUntrustedReason_ 只细化 reason         │
 * │ C. parsePlentiReferral_ 对邮件正文解析(Plenti 路径下正文为空)  │
 * │ C2. plEnrichFromBrowserView_ 抓 browser view 页面,真数据在这里 │
 * │    ⚠️ [R3 临时] PLENTI_FORCE_CREATE=true 可绕过判定门(D-017)   │
 * │ D. plResolve_          三层去重;referral 存储未实现即抛错      │
 * │ E. plCreateLead_       IV2_CREATE_ 防重锁 → POST → 回读        │
 * │ F. ivAttachSource_     仅 ATTACH_RAW_EMAIL==='true' 时执行     │
 * └──────────────────────────────────────────────────────────────┘
 *
 * 为什么推广/招聘正则在 B 之后而不是 A(DECISIONS D-010):可信 Plenti
 * 转介邮件的页脚极可能带营销话术。推广规则若在可信验证之前跑,真转介会
 * 被判成 promotion —— 这是一条真实的漏单路径。放在"不可信"分支下,它
 * 只影响 reason 文字,不可能误杀可信邮件。
 */

// ============================================================
// 配置常量
// ============================================================

/**
 * [Phase 3] 字段提取正则 —— **本期一律留空**,等 2026-09-09 会议拿到
 * 真实 Plenti 样本后再填。留空的后果是明确且安全的:每个字段都取不到值,
 * 必填字段缺失,confidence 恒为 low,parsePlentiReferral_ 恒返回
 * unknown/low,plProcess_ 一律转 review,永远不会创建 Lead。
 * 这正是骨架期应有的行为,不是缺陷。
 *
 * 每个字段是一个正则数组,按顺序尝试;取第一个捕获组(无捕获组则取整体)。
 * 同一字段匹配出多个**不同**的值 → 记入 ambiguous → 转 review(规格 §5.2
 * "出现多个候选 → review")。
 */
var PLENTI_PATTERNS={referralId:[],firstName:[],lastName:[],email:[],phone:[],street:[],city:[],state:[],postcode:[]};

/**
 * [Phase 3] 邮件种类判定正则 —— 同样留空。
 * 判定顺序固定为 notice → supplement → referral:notice 优先,避免一封
 * "放款完成通知"因为正文里带着转介编号而被误判成新转介(规格 §5.8:
 * 放款、文件处理、安装排期、售后、推广一律不建 Lead)。
 */
var PLENTI_KIND_PATTERNS={notice:[],supplement:[],referral:[]};

/** 缺任何一项即转 review,不以 Plenti 邮箱兜底创建(规格 §5.2)。 */
var PLENTI_REQUIRED_FIELDS=['referralId','lastName','email'];

// ============================================================
// 小工具
// ============================================================

/** 读邮件头;缺失返回空串。绝不回退到 getFrom()(规格 §5.1)。 */
function plHeader_(message,name){return String(message.getHeader(name)||'');}

/** 从 "Name <a@b>" 或裸地址取小写邮箱;取不到返回空串。 */
function plAddress_(raw){
 var s=String(raw||''),m=s.match(/<([^>]+)>/)||s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
 if(!m)return '';
 return String(m[1]||m[0]).trim().toLowerCase();
}

/** 取地址的域名部分(小写);取不到返回空串。 */
function plDomain_(address){var a=String(address||'').toLowerCase(),i=a.lastIndexOf('@');return i<0?'':a.slice(i+1);}

/**
 * 从一个逗号分隔的地址清单属性读出规范化条目。每项是完整地址 user@domain
 * 或 @domain,大小写不敏感。属性缺失或为空 → 抛错停止(规格 §3 禁止 #2)。
 *
 * PLENTI_TRUSTED_SENDERS 和 INTAKE_RECIPIENT_ALLOWLIST 共用这套格式与匹配。
 */
function plAddressList_(propertyName){
 var raw=PropertiesService.getScriptProperties().getProperty(propertyName),out=[];
 String(raw||'').split(',').forEach(function(part){var v=part.trim().toLowerCase();if(v)out.push(v);});
 if(!out.length)throw new Error('Configure '+propertyName);
 return out;
}

/**
 * 地址与清单条目的匹配核心。**只用相等比较,不用 indexOf / endsWith 子串
 * 匹配** —— 否则 @plenti.example 会匹配到 @evil-plenti.example。
 *
 * @domain 条目只匹配该域名本身,**子域名不自动命中**:mail.plenti.example
 * 必须显式列进属性。这是 fail-closed 的选择,放宽只需改配置、不必改代码。
 */
function plAddressMatches_(address,entries){
 var addr=String(address||'').toLowerCase(),domain=plDomain_(addr),i,e;
 if(!addr||!domain)return false;
 for(i=0;i<entries.length;i++){
  e=entries[i];
  if(e.charAt(0)==='@'){if(domain===e.slice(1))return true;}
  else if(addr===e)return true;
 }
 return false;
}

/** PLENTI_TRUSTED_SENDERS 的条目清单。 */
function plTrustedSenders_(){return plAddressList_('PLENTI_TRUSTED_SENDERS');}

/** 可信发件人判定。保留独立名字,因为语义与收件人白名单不同。 */
function plSenderTrusted_(address,entries){return plAddressMatches_(address,entries);}

// ============================================================
// R1 收件人白名单 —— 范围过滤,不是分类判断
// ============================================================

/**
 * 判断"投递给了谁"时检查的邮件头,取**并集**:任一命中即放行。
 *
 * 为什么是这四个(依据与不确定性都写在这里):
 *
 *   To / Cc            发信人写在信头上的收件人。Google Groups 转发后 To 通常
 *                      仍是组地址,所以多数情况够用。但它是**发信人可控**的,
 *                      而且 BCC 投递时根本不出现。
 *   Delivered-To       接收方 MTA 在实际投递时加的,值是真正的投递信箱。
 *                      Gmail 会写这个头;Google Groups 投递给成员的副本
 *                      通常带 `Delivered-To: <成员地址>`。
 *   X-Original-To      Postfix 系 MTA 的约定。Gmail 一般**不**写这个头,
 *                      列在这里是兜底,成本为零。
 *
 * ⚠️ **我对 Google Groups 实际写哪个头没有百分百把握。** 取并集是为了今天的
 * 实测不会因为猜错头而一封都进不来。实测拿到真实邮件后应当收窄到实际存在的
 * 那个头 —— 并集的代价是范围偏宽(例如你只是被 Cc 也会放行)。
 *
 * 一封邮件可能有多个 Delivered-To(转发链),`getHeader` 只返回第一个;
 * plAddresses_ 会把单个头值里的所有地址都取出来,这一点不受影响。
 */
var PLENTI_RECIPIENT_HEADERS=['To','Cc','Delivered-To','X-Original-To'];

/** 从一个邮件头的值里取出**全部**地址(小写去重)。To/Cc 可能有多个。 */
function plAddresses_(raw){
 var out=[],found=String(raw||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
 if(found)found.forEach(function(a){var v=a.trim().toLowerCase();if(out.indexOf(v)<0)out.push(v);});
 return out;
}

/** INTAKE_RECIPIENT_ALLOWLIST 的条目清单;未配置即抛错停止。 */
function plRecipientAllowlist_(){return plAddressList_('INTAKE_RECIPIENT_ALLOWLIST');}

/**
 * plRecipientAllowed_(message, entries) → bool
 *
 * eDocs 是业务共用邮箱,进来的邮件绝大多数与 Plenti 无关。这一层把处理范围
 * 收窄到"投递给指定地址"的邮件。
 *
 * ⚠️ **这是范围过滤,不是分类判断** —— 与 `list:` 查询同一性质(DECISIONS
 * D-015)。不命中的邮件在 runIntakeV2 的循环里直接跳过:不写状态、不打标签、
 * 不占 Script Properties。这不违反"绝不静默丢弃"原则 —— 那条针对的是**分类
 * 不确定**时不得丢弃,而地址白名单是确定性的边界,和 `list:` 一样。
 */
function plMatchedRecipient_(message,entries){
 var i,j,addresses;
 for(i=0;i<PLENTI_RECIPIENT_HEADERS.length;i++){
  addresses=plAddresses_(plHeader_(message,PLENTI_RECIPIENT_HEADERS[i]));
  for(j=0;j<addresses.length;j++){if(plAddressMatches_(addresses[j],entries))return addresses[j];}
 }
 return '';
}

/** 布尔形式。R7 的消息级日志要记"命中的是哪个地址",所以核心改成返回地址。 */
function plRecipientAllowed_(message,entries){return plMatchedRecipient_(message,entries)!=='';}

// ============================================================
// R7 消息正文取值
// ============================================================

/**
 * ⚠️ [Phase 3 占位] 邮件正文清洗 —— **现在直接透传,一个字符都不动。**
 *
 * 为什么现在不写:Plenti 的邮件格式 2026-09-09 才第一次见到。此刻写的任何
 * HTML 标签过滤或文本清洗规则都是猜的,大概率要推翻。而且 getPlainBody()
 * 返回的已经是 Gmail 转好的纯文本,**可能本身就够用** —— 也可能表格结构被
 * 拍扁导致 label 和 value 对不上。这个只有看到真实邮件才判断得了。
 *
 * 这一轮的目标是**把原料完整拿到手,不是加工它**。
 *
 * 将来的清洗逻辑就插在这个函数体里。改这里即可,调用点不用动:
 *   - 回落到 HTML 时是否剥标签(isHtml 参数就是为此留的)
 *   - 引用区/签名档/免责声明的处理
 *   - 表格布局被拍扁后 label 与 value 的重新对齐
 */
function plCleanBody_(text,isHtml){
 return text;
}

/**
 * plMessageBody_(message) → {text, isHtml}
 *
 * 优先 getPlainBody():纯文本更省空间,调正则时也更直观。
 * 为空时(纯 HTML 邮件且 Gmail 没生成文本版)回落 getBody(),**HTML 标签原样
 * 保留,不剥**,并把 isHtml 标出来让日志能标注。
 *
 * ⚠️ 与 D-014 不冲突:那条说的是 **Salesforce 的 Plenti_Raw_Email__c 存
 * getBody() 原始 HTML 作审计留底**。Sheet 是排查工具,用途不同,取值可以不同。
 */
function plMessageBody_(message){
 var text=String(message.getPlainBody()||'');
 if(text)return {text:plCleanBody_(text,false),isHtml:false};
 var html=String(message.getBody()||'');
 return {text:plCleanBody_(html,true),isHtml:true};
}

// ============================================================
// B. 发件人可信验证(规格 §5.1)
// ============================================================

/**
 * isPlentiSource_(message) → {trusted:bool, reason:string, sender:string}
 *
 * ⚠️ 本实现**必须用 2026-09-09 会议拿到的真实样本验证**。不能假设
 * Google Groups 一定保留了 X-Original-Sender 和
 * X-Original-Authentication-Results 这两个头。拿到样本第一件事是打印
 * 全部邮件头确认它们存在且格式如预期。
 *
 * 判定顺序,任何一步不满足即 trusted:false,reason 写明是哪一步失败:
 *   1. X-Original-Sender 头存在且能解析出地址 —— 缺失即失败,
 *      **绝不回退到 message.getFrom()**(Plenti 若设 p=reject,
 *      Groups 会把 From 改写成组地址)
 *   2. 该地址命中 PLENTI_TRUSTED_SENDERS
 *   3. X-Original-Authentication-Results 头存在
 *   4. 该头含 dmarc=pass,且若带 header.from 则域名与发件人域名一致
 *
 * 第 4 步选了严格版:只认 dmarc=pass,不接受"spf=pass 或 dkim=pass 其一"
 * (DECISIONS D-009)。DMARC 通过意味着 SPF 或 DKIM 至少一项通过**且域名
 * 对齐**;单独的 spf=pass 可能只是转发链上某一跳的结果。
 *
 * 预期风险:若样本显示 Plenti 没有 DMARC 记录、或用了宽松对齐,所有邮件
 * 会落到 review —— 可见、不丢失,而且我们会立刻从 reason 知道要调哪一步。
 * 届时会**有意识地**放宽并写进 DECISIONS,不是默默改掉。
 *
 * 显示名含 Plenti、主题含 Plenti、正文声称来自 Plenti —— 一律不构成证据,
 * 本函数从不读取这三者。
 */
function isPlentiSource_(message){
 var sender=plAddress_(plHeader_(message,'X-Original-Sender'));
 if(!sender)return {trusted:false,sender:'',reason:'X-Original-Sender header missing or unparsable'};
 if(!plSenderTrusted_(sender,plTrustedSenders_()))return {trusted:false,sender:sender,reason:'Sender is not listed in PLENTI_TRUSTED_SENDERS'};
 var auth=plHeader_(message,'X-Original-Authentication-Results');
 if(!auth)return {trusted:false,sender:sender,reason:'X-Original-Authentication-Results header missing'};
 if(!/\bdmarc\s*=\s*pass\b/i.test(auth))return {trusted:false,sender:sender,reason:'DMARC did not pass'};
 var declared=auth.match(/header\.from\s*=\s*([^\s;,)]+)/i);
 if(declared){
  var hf=String(declared[1]).replace(/^[<"']+/,'').replace(/[>"'.]+$/,'').toLowerCase();
  if(hf!==plDomain_(sender))return {trusted:false,sender:sender,reason:'header.from domain does not match X-Original-Sender domain'};
 }
 return {trusted:true,sender:sender,reason:'Trusted sender with DMARC pass'};
}

// ============================================================
// A. 排除规则(移植自模板 ivClassify_ 前半段)
// ============================================================

/**
 * plExclude_(subject, sender) → null(未被排除)或 {kind, reason, leadCandidate}
 *
 * **为什么不需要正文**:本函数负责的六类排除(内部 / Salesforce 通知 /
 * Web-to-Lead 失败 / 测试邮件 / 退信 / 自动回复)全部只看发件人和主题。
 * 招聘与推广需要正文,但它们移到了 plUntrustedReason_(只在不可信分支跑,
 * 见 D-010)。因此本函数完全不碰正文,也就不需要模板的 ivTop_ 引用边界
 * 截断 —— 那个截断会截掉 Plenti 表单资料(PLENTI_ADAPTATION.md 第 2 条)。
 *
 * ⚠️ 模板 L51 是 `if(!from || 内部域名) return internal`。发件人为空时
 * 判 internal 会把邮件**静默丢弃且不打标签**,而"X-Original-Sender 头缺失"
 * 恰恰是规格 §5.1 最担心的场景。这里必须拆开:空发件人 → review +
 * leadCandidate,必须有人看到。
 *
 * ⚠️ 模板 L58 把 no-reply 地址一律 ignore。Plenti 很可能用 no-reply 发信
 * (PLENTI_ADAPTATION.md 第 2 条明确警告),原样搬会漏单。这里拆成三条:
 * mailer-daemon / postmaster 地址 → ignore;退信与自动回复**主题** →
 * ignore;no-reply 地址**不再直接 ignore**,交给 isPlentiSource_ 判断 ——
 * 在可信清单里就是可信,不在就转 review。
 */
function plExclude_(subject,sender){
 var sub=String(subject||''),from=String(sender||'').toLowerCase();
 if(!from)return {kind:'review',reason:'Sender could not be determined from X-Original-Sender',leadCandidate:true};
 if(plDomain_(from)===ivInternalDomain_())return {kind:'internal',reason:'Internal sender'};
 if(/(?:^|\.)(?:salesforce\.com|sfcustomeremail\.com)$/i.test(plDomain_(from))&&/(?:a lead has been assigned|please follow up your unconverted lead)/i.test(sub))return {kind:'ignore',reason:'Salesforce automatic lead notification'};
 if(/(?:salesforce could not create this lead)/i.test(sub))return {kind:'review',reason:'Web-to-Lead failure requires administrator review'};
 if(/\btest\d*\b/i.test(sub))return {kind:'review',reason:'Possible test email'};
 if(/(?:mailer-daemon|postmaster)/i.test(from))return {kind:'ignore',reason:'Automatic message from the mail system'};
 if(/(?:delivery status notification|out of office|automatic reply)/i.test(sub))return {kind:'ignore',reason:'Automatic reply or delivery notification'};
 return null;
}

/**
 * plUntrustedReason_(subject, plain) → 更具体的 reason 字符串,或 ''。
 *
 * **只细化 reason,不改变结论。** 不可信邮件一律 review(规格 §5.1
 * "验证不通过 → review")。这里不把推广判成静默 ignore,原因见
 * DECISIONS D-010 与 Q10:静默丢弃与规格 §2 "认不出来转人工,绝不静默
 * 丢弃"直接冲突,而一封认证失败的**真** Plenti 转介如果因为页脚营销话术
 * 被判 promotion,就是一条漏单。审核噪音的问题等 Q10 拿到 eDocs 真实
 * 日均邮件量之后再定,依据是流量数据,不是感觉。
 *
 * 正则原样移植自模板 ivClassify_(招聘 L54 / 推广 L56-57 / 语音留言 L59)。
 * 这里对**完整正文**匹配而不做引用边界截断:不可信邮件没有表单资料需要
 * 保护,而截断逻辑属于 Legacy,主干不复制。
 */
function plUntrustedReason_(subject,plain){
 var sub=String(subject||'').toLowerCase(),text=String(plain||'').replace(/\s+/g,' ').toLowerCase();
 if(/(?:\b(?:recruitment|hiring) (?:team|manager)\b|\b(?:job application|applying for|trade assistant|cover letter|resume attached)\b)/i.test(sub+' '+text))return 'Employment enquiry - not a sales Lead';
 var pitch=/\b(?:we|our company|[a-z ]+ energia)\s+(?:are |is )?(?:offering|offer|provide|supply|selling)\b/.test(text)||/(?:opportunities (?:are )?(?:offered|for)|for (?:investors|developers)|land .*option agreements|we can (?:help|improve|boost)|seo services|marketing services|guest post)/.test(text);
 if(pitch)return 'Sender offering products, investment or services';
 if(/(?:new voice message|voicemail)/i.test(sub))return 'Voice recording needs review';
 return '';
}

// ============================================================
// R8 Browser view 抓取与解析(D-019)
// ============================================================

/**
 * ⚠️ 数据源反转:**客户数据不在邮件正文里,在 browser view 页面上。**
 *
 * 2026-09-09 实测确认:Plenti 邮件正文的客户字段是空的(Lily 直接收到的原件
 * 也一样,不是转发导致的)。Plenti 是上市金融机构,让他们改邮件模板不现实,
 * 我们只能自适应。**邮件正文的作用只剩两个:触发处理,以及提供这个链接。**
 *
 * 页面实测特征(Jack 用真实浏览器 + 本地 curl 双向验证):
 *   HTTP 200,0 次重定向,不依赖 cookie(纯靠 URL 里的 token 授权),
 *   0 个 <script>、0 个 <iframe> —— 纯静态,UrlFetchApp 直接可取。
 */
var PLENTI_BROWSER_VIEW_RE=/https?:\/\/[A-Za-z0-9.-]*customeriomail\.com\/deliveries\/[A-Za-z0-9_\-+\/=]+/i;

/**
 * 页面上的三个字段标签。**顺序无关**,配对靠文档顺序扫描,见 plParseBrowserView_。
 */
var PLENTI_BROWSER_LABELS=[
 {key:'name',label:'customer name'},
 {key:'address',label:'customer address'},
 {key:'systems',label:'renewable systems'}
];

/** 页面把"空值"渲染成空串或字面量 []。两者都算没取到。 */
function plBrowserValueEmpty_(text){var t=String(text||'').trim();return t===''||t==='[]';}

function plHtmlUnescape_(text){
 return String(text||'')
  .replace(/&nbsp;/gi,' ').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
  .replace(/&quot;/gi,'"').replace(/&#0?39;/g,"'").replace(/&apos;/gi,"'")
  .replace(/&#(\d+);/g,function(all,code){return String.fromCharCode(Number(code));})
  .replace(/&amp;/gi,'&');
}

/**
 * 片段 → 纯文本。`<br>` 转空格再压缩空白,这样**地址的换行会被合并成一行**
 * (Jack 观察到的逗号后换行:实测样本里是 CSS 窄列自动折行,不是 <br>;
 * 两种都靠这里的空白压缩兜住)。
 */
function plHtmlText_(fragment){
 return plHtmlUnescape_(String(fragment||'').replace(/<br\s*\/?>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
}

/** 从 URL 取 delivery token(末段 base64)。每封邮件唯一,用作 Plenti_Lead_ID__c。 */
function plDeliveryToken_(url){
 var m=String(url||'').match(/\/deliveries\/([A-Za-z0-9_\-+\/=]+)/);
 return m?m[1]:'';
}

/**
 * 从邮件里提取 View in Browser 链接。**纯文本版和 HTML 版形态不同,两种都要能提**:
 *   纯文本版:URL 裸露在正文里
 *   HTML 版: 藏在 <a href="..."> 里,且可能带 HTML 实体转义
 * 先试纯文本(更干净),取不到再试 HTML。
 */
function plBrowserViewUrl_(message){
 var sources=[String(message.getPlainBody()||''),String(message.getBody()||'')],i,m;
 for(i=0;i<sources.length;i++){
  m=plHtmlUnescape_(sources[i]).match(PLENTI_BROWSER_VIEW_RE);
  if(m)return m[0];
 }
 return '';
}

/**
 * 抓取页面。**任何失败都不抛错**,一律落在返回值里由调用方降级处理 ——
 * 抓取失败绝不能阻断建 Lead,SLA 时钟不等人(R8 第 6 点)。
 *
 * ⚠️ **UrlFetchApp 不提供超时参数。** Apps Script 的 fetch 没有可配置的
 * timeout 选项,我没有办法在这一层设。替代做法是调用方按本轮剩余预算决定
 * 要不要发起抓取(见 plProcess_ 的 deadline 判断)。这一点等 Phase 4 实测
 * 观察真实耗时后再评估是否需要更强的保护。
 */
function plFetchBrowserView_(url){
 var out={url:url||'',token:plDeliveryToken_(url),fetchedAt:new Date().toISOString(),ok:false,status:0,error:'',html:''};
 if(!out.url){out.error='No browser-view link found in the message';return out;}
 try{
  var response=UrlFetchApp.fetch(out.url,{method:'get',muteHttpExceptions:true,followRedirects:true});
  out.status=response.getResponseCode();
  if(out.status!==200){out.error='Browser view returned HTTP '+out.status;return out;}
  out.html=String(response.getContentText()||'');
  if(!out.html){out.error='Browser view returned an empty body';return out;}
  out.ok=true;
 }catch(e){out.error=String(e.message||e).slice(0,300);}
 return out;
}

function plBrowserLabelKey_(text){
 var t=String(text||'').replace(/[:：]\s*$/,'').trim().toLowerCase(),i;
 for(i=0;i<PLENTI_BROWSER_LABELS.length;i++){if(PLENTI_BROWSER_LABELS[i].label===t)return PLENTI_BROWSER_LABELS[i].key;}
 return '';
}

/**
 * plParseBrowserView_(html) → {name, address, systems, found:[], missing:[]}
 *
 * ⚠️ **页面里每个标签出现两次。** 模板为桌面/移动两套布局各渲染一份:
 *   第一组 标签 + 右对齐的真值
 *   第二组 标签 + **空值**(空 <p> 或字面量 [])
 * 朴素的"找到标签就取下一段文本"会取到第二组的空值。
 *
 * 配对算法:按文档顺序扫描 <p> 序列,每个标签向后找值,**撞到下一个标签就停**。
 * 第二组的标签后面紧跟着的是空值和下一个标签,因此天然取不到东西;
 * 只有第一组能配出值。首个配出值的occurrence 生效。
 *
 * 值优先取 `text-align: right` 的段落(实测模板用右对齐区分值列);
 * 取不到再退回该区间内第一个非空普通段落。
 */
function plParseBrowserView_(html){
 var out={name:'',address:'',systems:'',found:[],missing:[]};
 // 去掉全部 HTML 注释,连同 Outlook 的 <!--[if ...]> 条件块一起 —— 真值不在注释里。
 var body=String(html||'').replace(/<!--[\s\S]*?-->/g,'');
 var tokens=[],re=/<p\b([^>]*)>([\s\S]*?)<\/p>/gi,m,i,j,key,value,fallback,token;
 while((m=re.exec(body))!==null){
  tokens.push({right:/text-align\s*:\s*right/i.test(m[1]),label:/<strong\b/i.test(m[2]),text:plHtmlText_(m[2])});
 }
 for(i=0;i<tokens.length;i++){
  if(!tokens[i].label)continue;
  key=plBrowserLabelKey_(tokens[i].text);
  if(!key||out[key])continue;
  value='';fallback='';
  for(j=i+1;j<tokens.length;j++){
   token=tokens[j];
   if(token.label)break;
   if(plBrowserValueEmpty_(token.text))continue;
   if(token.right){value=token.text;break;}
   if(!fallback)fallback=token.text;
  }
  if(!value)value=fallback;
  if(value)out[key]=value;
 }
 for(i=0;i<PLENTI_BROWSER_LABELS.length;i++){
  key=PLENTI_BROWSER_LABELS[i].key;
  if(out[key])out.found.push(key);else out.missing.push(key);
 }
 return out;
}

/**
 * 澳洲地址轻量拆分。**匹配不上就整串塞 Street,不猜。**
 *
 * 只认最保守的一种形态:`<街道>, <城市> <州> <四位邮编>`,州必须是八个法定
 * 缩写之一。一个样本不足以支撑更激进的拆分规则(与 D-018 不清洗正文同一条
 * 理由),匹配不上时宁可让人看到完整原文,也不切错。
 */
function plSplitAuAddress_(raw){
 var out={street:String(raw||'').trim(),city:'',state:'',postcode:''};
 var m=out.street.match(/^(.*?),\s*([A-Za-z][A-Za-z '\-]*?)\s+(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s+(\d{4})$/i);
 if(m){out.street=m[1].trim();out.city=m[2].trim();out.state=m[3].toUpperCase();out.postcode=m[4];}
 return out;
}

/**
 * 抓取 + 解析 + 合并进 parsed。返回 {html, meta}:
 *   html —— 原始页面,进 Plenti_Browser_View_HTML__c(**不进 parsed**,
 *           否则 44KB 页面会被 JSON.stringify 进 Plenti_Parsed_JSON__c)
 *   meta —— 抓取元数据,进 parsed.browserView,随解析 JSON 一起留底
 *
 * 身份与数据分开对待:
 *   token 取到 → 身份确定,kind='referral',**即使抓取失败也要建 Lead**
 *   字段解析到 → confidence='high';否则 'low',Lead 照建但标记降级
 */
function plEnrichFromBrowserView_(message,parsed){
 var url=plBrowserViewUrl_(message),fetched=plFetchBrowserView_(url);
 var meta={url:fetched.url,token:fetched.token,fetchedAt:fetched.fetchedAt,ok:fetched.ok,
  status:fetched.status,error:fetched.error,found:[],missing:[],degraded:false};
 parsed.browserView=meta;
 if(!fetched.token){
  meta.degraded=true;
  parsed.reason='No Plenti browser-view link found in the message; '+parsed.reason;
  return {html:'',meta:meta};
 }
 // 有 token 就有稳定身份 —— 这是 Plenti 转介,后面无论如何都要建 Lead。
 parsed.kind='referral';
 if(!parsed.referralId)parsed.referralId=fetched.token;
 if(!fetched.ok){
  meta.degraded=true;
  meta.missing=['name','address','systems'];
  parsed.confidence='low';
  parsed.reason='Browser view fetch failed: '+fetched.error+'. Lead created from the email alone; open the link manually for customer details.';
  return {html:'',meta:meta};
 }
 var fields=plParseBrowserView_(fetched.html);
 meta.found=fields.found;
 meta.missing=fields.missing;
 parsed.systems=fields.systems;
 if(fields.name)parsed.customer.lastName=fields.name;
 if(fields.address){
  var address=plSplitAuAddress_(fields.address);
  parsed.customer.addressRaw=fields.address;
  parsed.customer.street=address.street;
  parsed.customer.city=address.city;
  parsed.customer.state=address.state;
  parsed.customer.postcode=address.postcode;
 }
 if(fields.name){
  parsed.confidence='high';
  parsed.reason='Parsed '+fields.found.length+' field(s) from the Plenti browser view';
 }else{
  meta.degraded=true;
  parsed.confidence='low';
  parsed.reason='Browser view fetched but the customer name could not be parsed; template may have changed';
 }
 return {html:fetched.html,meta:meta};
}

// ============================================================
// C. 解析骨架(字段正则本期留空)
// ============================================================

/** 按 patterns 依次匹配,收集**去重后**的候选值。candidates>1 即多候选。 */
function plMatchField_(text,patterns){
 var found=[],src=String(text||'');
 (patterns||[]).forEach(function(re){
  var m=src.match(re);
  if(!m)return;
  var v=String(m[1]!==undefined?m[1]:m[0]).trim();
  if(v&&found.indexOf(v)<0)found.push(v);
 });
 return {value:found.length?found[0]:'',candidates:found.length};
}

/** notice → supplement → referral 顺序;全不命中返回 unknown。 */
function plMatchKind_(subject,text){
 var hay=String(subject||'')+'\n'+String(text||''),order=['notice','supplement','referral'],i,j,list;
 for(i=0;i<order.length;i++){
  list=PLENTI_KIND_PATTERNS[order[i]]||[];
  for(j=0;j<list.length;j++){if(list[j].test(hay))return order[i];}
 }
 return 'unknown';
}

/** 把解析结果翻译成给审核人看的人话。 */
function plParseReason_(r){
 var parts=[];
 if(r.kind==='unknown')parts.push('Plenti message kind not recognised');
 if(r.missing.length)parts.push('Missing required field(s): '+r.missing.join(', '));
 if(r.ambiguous.length)parts.push('Multiple candidate values for: '+r.ambiguous.join(', '));
 return parts.length?parts.join('; '):'Parsed as '+r.kind;
}

/**
 * parsePlentiReferral_(message) → {
 *   kind:'referral'|'supplement'|'notice'|'unknown',
 *   referralId:'', customer:{...}, confidence:'high'|'low',
 *   missing:[], ambiguous:[], reason:''
 * }
 *
 * confidence 规则:kind 明确 + 必填字段齐全 + 无多候选 = high,否则 low。
 * 只有 kind==='referral' 且 confidence==='high' 才可能走到创建路径。
 *
 * 客户身份**只从正文明确字段取**,绝不以发件人邮箱兜底(规格 §5.2)。
 * 本函数从不读取发件人。
 *
 * [Phase 3] PLENTI_PATTERNS / PLENTI_KIND_PATTERNS 填正则即可,本函数的
 * 错误处理、缺字段收集、多候选检测、置信度判断都已就位,不需要再改。
 */
function parsePlentiReferral_(message){
 var body=String(message.getPlainBody()||''),subject=String(message.getSubject()||'');
 var result={kind:'unknown',referralId:'',customer:{firstName:'',lastName:'',email:'',phone:'',street:'',city:'',state:'',postcode:''},confidence:'low',missing:[],ambiguous:[],reason:''};
 var fields={};
 result.kind=plMatchKind_(subject,body);
 Object.keys(PLENTI_PATTERNS).forEach(function(name){
  var hit=plMatchField_(body,PLENTI_PATTERNS[name]);
  fields[name]=hit.value;
  if(hit.candidates>1)result.ambiguous.push(name);
 });
 result.referralId=fields.referralId;
 ['firstName','lastName','email','phone','street','city','state','postcode'].forEach(function(name){result.customer[name]=fields[name];});
 PLENTI_REQUIRED_FIELDS.forEach(function(name){if(!fields[name])result.missing.push(name);});
 result.confidence=(result.kind!=='unknown'&&!result.missing.length&&!result.ambiguous.length)?'high':'low';
 result.reason=plParseReason_(result);
 return result;
}

// ============================================================
// D. 去重与解析目标
// ============================================================

// ============================================================
// R3 临时强制创建开关 —— ⚠️ Phase 4 结束后必须整节删除
// ============================================================

/**
 * ⚠️⚠️ 临时代码,DECISIONS D-017。Phase 4 验收结束后**连同 plForcedParse_
 * 和两处调用点一起删掉**,不要留到上线。
 *
 * 存在理由:解析骨架恒返回 unknown/low,`plCreateLead_` 在正常路径上执行不到,
 * 于是"真正写 Lead"这一跳是整条链里唯一没被任何代码验证过的。这个开关让它
 * 在拿到样本之前也能被真实跑一次。
 *
 * PLENTI_FORCE_CREATE 精确等于字符串 'true' 才算开。未配置 = 关闭。
 * 与 ATTACH_RAW_EMAIL 同样刻意不抛错 —— 默认关闭才是安全方向。
 *
 * **开关只在这一个函数里读。** 正常判定逻辑一行未改:调用点各是一个单行
 * guard,`parsePlentiReferral_` 保持诚实(照旧返回 unknown/low,不让解析器
 * 谎报自己解析成功)。
 */
function plForceCreate_(){return PropertiesService.getScriptProperties().getProperty('PLENTI_FORCE_CREATE')==='true';}

/**
 * ⚠️ 临时代码,随 plForceCreate_ 一起删。
 *
 * 把解析结果补成刚好能过 plResolve_ 的最小集合。**保留所有真实解析到的值**,
 * 只填空缺 —— Phase 3 填了正则之后,强制模式仍会用真实值,只补缺的那几个。
 *
 * 合成值的两条安全约束:
 *   - referralId 用 FORCED-<msgId>:与消息一一对应,重跑同一封不会变,
 *     且一眼看得出是测试数据
 *   - email 用 @example.invalid:`.invalid` 是 RFC 2606 保留的不可路由 TLD。
 *     **这一条是防止 Salesforce 的自动回复 Flow 真的把邮件发给某个真实地址** ——
 *     绝不能拿发件人地址来兜底,那正是规格 §5.2 禁止的事。
 */
function plForcedParse_(message,parsed){
 var id=message.getId(),forced={kind:'referral',customer:{},confidence:'high',missing:[],ambiguous:[],
  reason:'PLENTI_FORCE_CREATE bypassed the confidence gate; values below may be synthetic'};
 forced.referralId=parsed.referralId||('FORCED-'+id);
 Object.keys(parsed.customer).forEach(function(k){forced.customer[k]=parsed.customer[k];});
 if(!forced.customer.lastName)forced.customer.lastName='Forced Test '+id;
 if(!forced.customer.email)forced.customer.email='forced-'+id+'@example.invalid';
 return forced;
}

/**
 * 业务级去重的第三层:按 Plenti referral ID 找已有 Lead(规格 §5.4)。
 *
 * [Phase 2 fail-closed 桩] 本函数直接抛错,阻塞项是 Q6 —— referral ID
 * 存 Lead 自定义字段还是 Script Properties 尚未决定(倾向 Lead 字段,
 * 因为 Properties 有 500KB 上限且不可靠),而且要等样本确认 ID 格式。
 *
 * **为什么抛错而不是返回 null**:返回 null 会让 plResolve_ 继续往下走到
 * 创建路径,等于在没有业务级去重的情况下建 Lead —— Plenti 把同一转介
 * 重发成新邮件就会产生第二个 Lead(§7 验收表明确禁止)。Gmail ID 只能防
 * 同一封邮件,防不住重发。宁可整条路径卡死,也不放行。
 */
/** Plenti 路径的查询字段集 = 基础字段 + delivery token 字段。 */
function plLeadFields_(){return ivLeadFields_()+',Plenti_Lead_ID__c';}

/**
 * 业务级去重的第三层(规格 §5.4),**已从 fail-closed 桩落地为真实查询**。
 *
 * Q6 已定:delivery token 存 Lead 自定义字段 Plenti_Lead_ID__c。token 来自
 * browser-view URL 末段,每封邮件唯一且稳定 —— 这正是之前拿不到、导致这层
 * 只能抛错卡住的那个稳定标识。
 *
 * ⚠️ 这个查询要求 Plenti_Lead_ID__c 在目标 org 中**已存在**。字段不存在时
 * SOQL 会报 INVALID_FIELD,落 error 状态并触发 L-01(防重锁不回滚)。
 * 启用前必须先按 SANDBOX_SETUP 第 7 节建好字段。
 *
 * 命中多条 → 抛错要求人工核查,不猜。Unique 约束本应挡住这种情况,
 * 抛错是防它没被勾上。
 */
function plFindReferral_(referralId){
 var token=String(referralId||'');
 if(!token)return null;
 var rows=ivQuery_("SELECT "+plLeadFields_()+" FROM Lead WHERE Plenti_Lead_ID__c='"+ivQuote_(token)+"'");
 if(rows.length>1)throw new Error('Multiple Leads share Plenti_Lead_ID__c '+token+'; manual review required');
 return rows.length?rows[0]:null;
}

/**
 * plResolve_(message, parsed) → {lead} | {lead,supplement:true} | {create:true} | {review:reason}
 *
 * 三层去重(规格 §5.4)+ 跨邮箱缓解(规格 §5.5):
 *   D1 邮件级:Description 里已有 [Intake: msgId] → 返回已有 Lead(同一封
 *      邮件重跑,§7 验收"同一封邮件跑两次不重复建")
 *   D2 业务级:referral ID 查找 —— Phase 2 抛错,见 plFindReferral_
 *   D3 跨邮箱:同客户邮箱已有活跃 Lead → review,不自动合并
 *      (info 与 eDocs 写入同一个 Salesforce,两边的锁无法跨项目原子操作,
 *       这是已知限制,不是完备方案)
 */
function plResolve_(message,parsed,forced){
 // [R8] 主键换成 delivery token。客户邮箱不再是必要条件 —— Plenti 从不提供
 // 客户邮箱(2026-09-09 实测确认),要求它等于永远不建 Lead。§5.2 真正禁止的是
 // "拿 Plenti 的地址当客户邮箱",那一条继续守着:取不到就不写 Email 字段。
 if(!parsed.referralId)return {review:'No Plenti delivery token; refusing to create a Lead without a stable identifier'};
 var marker='[Intake: '+message.getId()+']';
 // 第 2 层 业务级:同一 delivery token 已建过 → 直接返回,不重复创建。
 // 这一层同时覆盖了"同一封邮件跑两次"和"同一转介重发成新邮件"两种情况。
 // ⚠️ [R3 临时] 强制模式跳过,因为它的 token 是合成的 FORCED-<msgId>,
 // 查 Salesforce 没有意义。D-017,Phase 4 后删。
 var byReferral=forced?null:plFindReferral_(parsed.referralId);
 if(byReferral)return {lead:byReferral};
 // 第 1 层 邮件级:Description 里的 [Intake: msgId] 标记。token 查询已经覆盖
 // 绝大多数情况,这一层是 Plenti_Lead_ID__c 尚未建好时的退路(D-013)。
 if(parsed.customer.email){
  var leads=ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Email='"+ivQuote_(String(parsed.customer.email).toLowerCase())+"'");
  var sourced=leads.filter(function(l){return String(l.Description||'').indexOf(marker)>=0;});
  if(sourced.length===1)return {lead:sourced[0]};
  if(sourced.length>1)return {review:'Multiple Leads carry this message marker; manual review required'};
  // 第 3 层 跨邮箱缓解(规格 §5.5):仅在有客户邮箱时可用。Plenti 路径通常没有,
  // 这是一处**已知的能力退化**,记在 DECISIONS D-019。
  var open=leads.filter(function(l){return !l.IsConverted&&l.Status!=='Unqualified';});
  if(open.length)return {review:'Existing active Lead for this customer email; confirm same request versus a new project'};
 }
 return {create:true};
}

// ============================================================
// E. 创建
// ============================================================

/**
 * Lead 字段映射(规格 §5.9)。未决字段按规格写法先写,逐条标 Q 号 ——
 * 这条路径在 Phase 4 之前根本执行不到(两道安全开关 + 无凭据 + 解析骨架
 * 恒返回 unknown),不构成风险。
 *
 * Email 取的是**客户**邮箱,不是发件人(规格 §5.2)。
 *
 * Description 只写结构化摘要,**不复制邮件正文**(DECISIONS D-012):
 * Plenti 转介邮件可能含融资申请资料与身份证明,PLENTI_ADAPTATION.md 第 11
 * 条要求"仅留存销售必要信息"。若审核人反映上下文不够,那是 Q5 数据留存
 * 范围的一部分,由 Jack 拍板后再放开。
 *
 * ⚠️ [Phase 3 注意] Description 里**除 referralId 外不写任何 Plenti 内部
 * 标识符** —— application ID、broker ID、客户编号、账户号一律不进。等看到
 * 真实样本、确认哪些字段算"销售必要信息"之后再逐项放开,现在按最小集合写。
 * 填字段正则时不要顺手把解析到的编号都塞进摘要。
 * 这条由 testPlentiLeadPayload 的白名单断言强制:Description 的每一行都
 * 必须命中允许的前缀,加新行会让测试变红。
 */
var PLENTI_LONG_TEXT_LIMIT=131072;
var PLENTI_JSON_LIMIT=32768;
var PLENTI_DESCRIPTION_LIMIT=32000;

/** 截断并标注,标注算在上限之内(D-013)。 */
function plTruncateField_(value,limit){
 var text=String(value||''),marker='… [TRUNCATED]';
 return text.length<=limit?text:text.slice(0,limit-marker.length)+marker;
}

function plLeadPayload_(message,parsed,enrichment){
 var c=parsed.customer,marker='[Intake: '+message.getId()+']',meta=(enrichment&&enrichment.meta)||{};
 var fieldCount=(meta.found||[]).length;
 var payload={
  LastName:plTruncateField_(c.lastName||('Plenti referral '+String(parsed.referralId||'').slice(0,24)),80),
  Status:'New',
  OwnerId:ivAdmin_(),
  LeadSource:'Plenti',
  Company:'Individual / Residential',
  Contact_Attempt_Count__c:0,
  Plenti_Received_At__c:message.getDate().toISOString(),
  // D-014:审计留底存**原始 HTML**,不存 Gmail 转好的文本 —— 转换有损,
  // 留底若存派生物,将来发现解析漏字段就没有原文可回填了。
  Plenti_Raw_Email__c:plTruncateField_(message.getBody(),PLENTI_LONG_TEXT_LIMIT),
  Plenti_Browser_View_HTML__c:plTruncateField_((enrichment&&enrichment.html)||'',PLENTI_LONG_TEXT_LIMIT),
  Plenti_Parsed_JSON__c:plTruncateField_(JSON.stringify(parsed),PLENTI_JSON_LIMIT),
  // D-013:一行摘要,不复制原文。marker 是承重结构,不能删。
  Description:plTruncateField_(marker+' Plenti referral received '+message.getDate().toISOString()+'; '+fieldCount+' fields parsed'+(meta.degraded?' [BROWSER VIEW UNAVAILABLE — open the link in the raw email for customer details]':''),PLENTI_DESCRIPTION_LIMIT)
 };
 // 解析不到 delivery token 就**不传该字段**(R8 第 4 点)。
 if(parsed.referralId)payload.Plenti_Lead_ID__c=parsed.referralId;
 // §5.2:客户邮箱取不到就不写,**绝不拿 Plenti 的地址兜底**。
 if(c.email)payload.Email=c.email;
 if(c.firstName)payload.FirstName=plTruncateField_(c.firstName,40);
 if(c.phone)payload.Phone=c.phone;
 if(c.street)payload.Street=c.street;
 if(c.city)payload.City=c.city;
 if(c.state){payload.StateCode=String(c.state).toUpperCase();payload.CountryCode='AU';}
 if(c.postcode){payload.PostalCode=c.postcode;payload.CountryCode='AU';}
 return payload;
}

/**
 * 创建前防重锁(规格 §2 第三样可继承的东西,模板 Code.gs L113)。
 *
 * IV2_CREATE_<msgId> 属性已存在 → 抛错要求人工核查,**不重试创建**。
 * 这防的是"API 超时、结果不确定"的场景:上一次可能已经建成 Lead 但脚本
 * 没收到响应。盲目重建会产生重复 Lead。
 * requested → POST → created 的写入顺序不能调换。
 */
function plCreateLead_(message,parsed,enrichment){
 var id=message.getId(),p=PropertiesService.getScriptProperties();
 if(p.getProperty('IV2_CREATE_'+id))throw new Error('Earlier create outcome is uncertain; check Salesforce before retrying creation');
 var payload=plLeadPayload_(message,parsed,enrichment);
 p.setProperty('IV2_CREATE_'+id,JSON.stringify({state:'requested',at:new Date().toISOString()}));
 var result=ivReq_('sobjects/Lead','post',payload);
 p.setProperty('IV2_CREATE_'+id,JSON.stringify({state:'created',id:result.id,at:new Date().toISOString()}));
 return ivQuery_("SELECT "+plLeadFields_()+" FROM Lead WHERE Id='"+ivQuote_(result.id)+"'")[0];
}

// ============================================================
// review 状态解除
// ============================================================

/**
 * [Phase 2 空操作桩] 不改任何状态,直接返回。
 *
 * 模板用 Lead_Category__c 从 Other 改成 New Sales Enquiry 作为"管理员已
 * 审核"的信号,来自动清除 review 状态和 Gmail 标签。**Plenti 不复用该
 * 字段**(DECISIONS D-011):语义不符(Plenti 转介按定义就是销售线索)、
 * 那是 Lily 为 info 模型建的字段(两个邮箱写不同语义会污染两边报表)、
 * 且 LeadSource='Plenti' 已足够区分来源。
 *
 * 连带后果:review 状态在 Phase 2 **没有自动解除机制**,Gmail 的
 * SF-Lead-Review 标签需要人工处理。真正的解除信号大概率应该是
 * "Lead 被指派给跟进人",但那阻塞在 Q1(谁跟进 Plenti 线索)。
 *
 * [TODO Q9] 阻塞项 Q1。本函数保持空操作,使 Code.gs 的
 * ivRefreshOutstanding_ 在改调它之后仍能正常工作。
 */
function plRefreshReview_(message){
 return;
}

// ============================================================
// R9 离线注入测试入口 —— ⚠️ Phase 4 结束后必须整节删除(与 R3 一起)
// ============================================================

/**
 * ⚠️⚠️ 临时代码,DECISIONS D-020。Phase 4 验收结束后**整节删掉**,
 * 与 R3(plForceCreate_ / plForcedParse_)一起清理。
 *
 * 存在理由:eDocs 组还没建好,进组遥遥无期。目前唯一的真实样本是 Lily
 * 转发到 Jack 收件箱的那封邮件,而**转发件没有 List-ID 头**,主流程的
 * `list:<组地址>` 查询搜不到它。
 *
 * **主流程的查询条件一个字都没改。** 为了测试去动 runIntakeV2 的查询会
 * 引入一个"上线前必须记得改回来"的临时状态,风险比多一个测试入口大得多。
 * 这个入口绕过的只有 `list:` 查询和 watermark 两件事,其余全部走真实路径。
 *
 * 覆盖:白名单检查 → 解析 → browser view 抓取 → 建 Lead → 标签 → Sheet 日志
 * 不覆盖:**组投递识别**(`list:` 查询本身)。等组建好后单独补测这一环。
 *
 * ⚠️ 两道安全开关照常生效 —— 这个入口不绕过它们(规格 §3 禁止 #3)。
 * ⚠️ 照常持有 script lock,避免与定时触发器打架。
 *
 * @param messageId Gmail 消息 ID(取法见 plTestFindMessages)
 * @param force     true 时重跑已处理过的邮件。**不会**清除 IV2_CREATE_ 防重锁,
 *                  所以重跑不会重复建 Lead —— 它会按 delivery token 找到既有
 *                  Lead 并返回,这本身就是一条值得跑的幂等性验证。
 * @return plProcess_ 的 state,或 null(开关关闭 / 白名单未命中)
 */
function plTestFromMessageId(messageId,force){
 var p=PropertiesService.getScriptProperties();
 if(p.getProperty('INTAKE_V2_ENABLED')!=='true'){console.log('[R9] Intake v2 held pending validation — nothing was processed.');return null;}
 if(p.getProperty('EDOCS_ADAPTATION_VALIDATED')!=='true')throw new Error('Plenti adaptation has not been validated. Read handoff instructions.');
 var lock=LockService.getScriptLock();
 if(!lock.tryLock(1000)){console.log('[R9] Another intake execution is running.');return null;}
 try{
  var began=Date.now(),id=String(messageId||'').trim();
  if(!id)throw new Error('plTestFromMessageId needs a Gmail message id; run plTestFindMessages() to find one');
  var message=GmailApp.getMessageById(id);
  if(!message)throw new Error('No Gmail message found with id '+id);
  console.log('[R9] ⚠️ TEST ENTRY POINT — bypassing the list: query and watermark. Main-flow query is unchanged.');
  console.log('[R9] message '+id+' | '+message.getDate().toISOString()+' | '+message.getSubject());

  var recipient=plMatchedRecipient_(message,plRecipientAllowlist_());
  if(!recipient){
   console.log('[R9] STOP: no recipient matched INTAKE_RECIPIENT_ALLOWLIST. Checked headers: '+PLENTI_RECIPIENT_HEADERS.join(', '));
   console.log('[R9] Add the delivery address to INTAKE_RECIPIENT_ALLOWLIST and retry.');
   return null;
  }
  console.log('[R9] allowlist matched: '+recipient);

  // 抓取前先把链接情况打出来 —— 转发件的 View in Browser 链接可能被重写或丢失,
  // 这是本轮最需要先看清的一件事。
  var url=plBrowserViewUrl_(message);
  console.log('[R9] browser-view link: '+(url||'(NOT FOUND — see the note below)'));
  if(!url)console.log('[R9] No link means no stable identifier, so no Lead will be created (by design, D-019). To exercise the degraded-create path anyway, set PLENTI_FORCE_CREATE=true.');

  var detail={},state=plProcess_(message,force===true,detail);
  var view=(detail.parsed&&detail.parsed.browserView)||{};
  console.log('[R9] result: state='+state.state+' kind='+state.kind+' created='+(state.created===true)+' record='+(state.record||'(none)'));
  console.log('[R9] browser view: ok='+(view.ok===true)+' status='+(view.status||0)+' degraded='+(view.degraded===true)+' fields='+((view.found||[]).join(',')||'(none)')+(view.error?' error='+view.error:''));
  console.log('[R9] reason: '+state.reason);

  try{ivSyncLabels_(message.getThread());}catch(e){console.log('[R9] label sync failed (not fatal): '+String(e.message||e).slice(0,200));}

  var stats={threads:1,skipped:0,processed:1,
   created:(state.created&&state.record)?1:0,
   failed:state.state==='error'?1:0,
   errors:state.state==='error'?[id+': '+String(state.reason||'').slice(0,200)]:[],
   forced:plForceCreate_()};
  ivLogRun_(began,stats);
  ivLogMessages_([ivMessageLogRow_(message,recipient,state,detail)]);
  return state;
 }finally{lock.releaseLock();}
}

/**
 * ⚠️ 临时代码,随 plTestFromMessageId 一起删。
 *
 * 列出匹配某个 Gmail 查询的消息 ID。**只读,不处理、不写任何状态。**
 *
 * 为什么需要它:Gmail 网页地址栏最后那段(形如 `FMfcgzQb...`)是新版
 * **会话** ID,与 `GmailApp.getMessageById()` 需要的十六进制**消息** ID
 * 不是同一个东西,直接抄地址栏多半取不到邮件。用这个函数取才可靠。
 *
 * 用法示例(在 Apps Script 编辑器里改参数后运行):
 *   plTestFindMessages('subject:"Action required: New lead" newer_than:7d')
 */
function plTestFindMessages(query){
 var q=String(query||'newer_than:7d'),threads=GmailApp.search(q,0,20),i,j,msgs,m,rows=0;
 console.log('[R9] query: '+q+' → '+threads.length+' thread(s)');
 for(i=0;i<threads.length;i++){
  msgs=threads[i].getMessages();
  for(j=0;j<msgs.length;j++){
   m=msgs[j];rows++;
   console.log('[R9] id='+m.getId()+' | '+m.getDate().toISOString()+' | from='+m.getFrom()+' | '+m.getSubject());
  }
 }
 if(!rows)console.log('[R9] No messages matched. Widen the query, e.g. plTestFindMessages("newer_than:2d").');
 return rows;
}

// ============================================================
// 主流程
// ============================================================

/**
 * plProcess_(message, force) → state
 *
 * 状态机骨架移植自模板 ivProcess_:prior 检查(幂等)→ 分流 → 写中间态
 * → 处理 → 写终态;catch 一律落 error 不吞异常。
 *
 * review 兜底原则(规格 §2 第二样可继承的东西)贯穿所有分支:认不出来
 * 一律转人工,**绝不静默丢弃**。唯一静默的是 plExclude_ 判定的
 * internal / ignore 和解析确认的 notice —— 这三类是有明确证据的排除,
 * 不是"认不出来"。
 */
function plProcess_(message,force,detail){
 // [R7] detail 是**出参**,给消息级日志用。刻意不放进 state —— state 会被
 // ivSave_ 序列化进 Script Properties,而解析结果 JSON 放进去会撑爆 500KB 上限。
 detail=detail||{};
 var id=message.getId(),prior=ivGet_(id);
 if(prior&&!force&&prior.state!=='error')return prior;
 var state={state:'done',kind:'',leadCandidate:false,reason:'',date:message.getDate().toISOString()};
 try{
  var sender=plAddress_(plHeader_(message,'X-Original-Sender'));
  var excluded=plExclude_(message.getSubject(),sender);
  if(excluded){
   state.kind=excluded.kind;
   state.reason=excluded.reason;
   state.leadCandidate=!!excluded.leadCandidate;
   if(excluded.kind==='review')state.state='review';
   ivSave_(id,state);
   return state;
  }
  var source=isPlentiSource_(message);
  detail.sender=source.sender;
  detail.trusted=source.trusted;
  if(!source.trusted){
   var refined=plUntrustedReason_(message.getSubject(),message.getPlainBody());
   state.kind='review';
   state.state='review';
   state.leadCandidate=true;
   state.reason=(refined?refined+' — ':'')+'not a verified Plenti sender: '+source.reason;
   ivSave_(id,state);
   return state;
  }
  var parsed=parsePlentiReferral_(message);
  // [R8] 数据源反转:客户数据不在邮件正文,在 browser view 页面上。
  // 邮件只负责触发处理和提供链接,真正的字段由这一步抓回来。
  var enrichment=plEnrichFromBrowserView_(message,parsed);
  detail.parsed=parsed;
  detail.browserView=parsed.browserView;
  state.kind=parsed.kind;
  state.browserView=parsed.browserView?{ok:parsed.browserView.ok,status:parsed.browserView.status,degraded:parsed.browserView.degraded}:null;
  if(parsed.kind==='notice'){
   state.reason='Plenti non-referral notice, no Lead created: '+parsed.reason;
   ivSave_(id,state);
   return state;
  }
  if(parsed.kind==='supplement'){
   state.state='review';
   state.leadCandidate=true;
   state.reason='Plenti supplement to an existing referral; the update path is not implemented (blocked on Q6). '+parsed.reason;
   ivSave_(id,state);
   return state;
  }
  // [R8] 判定门的语义变更(D-019),理由见该条:
  //   身份确定(拿到 delivery token)→ 建 Lead,**即使字段抓取失败**。
  //   Jack:"绝不能因为抓取失败就不建 Lead —— SLA 时钟不等人。"
  //   身份不确定(没有 browser-view 链接)→ 仍然转 review,不建。
  // confidence 从"门"降级为"标记":它记录数据完整度,不再决定建不建。
  // "认不出来转人工"原则没有松动 —— kind==='unknown' 依旧一律 review。
  var forced=false;
  if(parsed.kind!=='referral'||!parsed.referralId){
   // ⚠️ [R3 临时] 唯一一处绕过判定的地方。D-017,Phase 4 后连同
   // plForceCreate_ / plForcedParse_ 一起删。上面的判定逻辑一行未改。
   if(!plForceCreate_()){
    state.state='review';
    state.leadCandidate=true;
    state.reason='Not identifiable as a Plenti referral: '+parsed.reason;
    ivSave_(id,state);
    return state;
   }
   console.log('⚠️ PLENTI_FORCE_CREATE is enabled — bypassing the confidence gate for message '+id+' (was: '+parsed.reason+')');
   parsed=plForcedParse_(message,parsed);
   detail.parsed=parsed;
   forced=true;
   state.kind=parsed.kind;
   state.forced=true;
  }
  var resolved=plResolve_(message,parsed,forced);
  if(resolved.review){
   state.state='review';
   state.leadCandidate=true;
   state.reason=resolved.review;
   ivSave_(id,state);
   return state;
  }
  if(resolved.supplement){
   state.state='review';
   state.leadCandidate=true;
   state.record=resolved.lead.Id;
   state.reason='Supplement matched an existing Lead by referral ID; field update path is not implemented (blocked on Q6)';
   ivSave_(id,state);
   return state;
  }
  var lead=resolved.lead;
  if(!lead){
   ivSave_(id,{state:'error',reason:'Lead creation in progress',date:state.date,leadCandidate:true});
   lead=plCreateLead_(message,parsed,enrichment);
   state.created=true;
  }
  state.record=lead.Id;
  state.attached=ivAttachSource_(message,{id:lead.Id});
  state.state='review';
  state.leadCandidate=true;
  state.reason=(forced?'[FORCED] ':'')+(parsed.confidence!=='high'?'[DEGRADED] ':'')+(state.created?'New Plenti Lead awaiting administrator approval':'Existing Lead matched by delivery token or message marker');
  ivSave_(id,state);
  return state;
 }catch(e){
  state.state='error';
  state.leadCandidate=true;
  state.reason=String(e.message||e).slice(0,1800);
  ivSave_(id,state);
  console.log('Plenti intake error '+id+': '+state.reason);
  return state;
 }
}
