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
 // [R15] unverified 标记交给 plProcess_ 统一处理可见性 —— 转发件正是走这一条
 // (转发件没有 X-Original-Sender)。这里**仍然绝不判 internal、仍然落 review**,
 // Jack 当初立的那条硬要求没有松动;变的只是"打不打标签",由有没有 Plenti
 // 链接决定,见 plUnverifiedReview_。
 if(!from)return {kind:'review',reason:'Sender could not be determined from X-Original-Sender',leadCandidate:true,unverified:true};
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
 // [R17] 2026-09-10 的正式 lead 多出这一项。双区块陷阱同样适用 —— 配对算法对
 // 每个标签独立扫描、撞到下一个标签就停,加一行标签即可,不需要改算法。
 {key:'phone',label:'customer phone'},
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
 * plParseBrowserView_(html) → {name, phone, address, systems, found:[], missing:[]}
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
 var out={name:'',phone:'',address:'',systems:'',found:[],missing:[]};
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
 * 只留数字,并把 +61 国际格式折回本地格式 —— **仅用于比较,从不写入 Salesforce**。
 * Salesforce 里存的是原样(D-029:Jack 倾向原样存,原始值另在 JSON 里留底)。
 */
function plNormalizeDigits_(value){
 var digits=String(value||'').replace(/\D+/g,'');
 if(/^61\d{9}$/.test(digits))digits='0'+digits.slice(2);
 return digits;
}

/**
 * 澳洲号码按编号规划分流:04 开头是手机 → MobilePhone,其余 → Phone。
 * 编号规划是固定的,这不是猜。手机号放进 MobilePhone 语义才对 —— SMS 和
 * 点击发短信这类集成都认这个字段;反过来把座机塞进 MobilePhone 就是错的。
 */
function plPhoneField_(phone){return /^04\d{8}$/.test(plNormalizeDigits_(phone))?'MobilePhone':'Phone';}

/**
 * 联系方式的指纹。用来记住"这个值是我们自己写进去的",让 plRefreshReview_
 * 不把它误当成人补的(D-029)。
 *
 * **存的是哈希不是号码** —— 状态落在 Script Properties 里,不值得为了一次
 * 比较多放一份客户电话的明文副本。
 */
function plContactHash_(value){
 var digits=plNormalizeDigits_(value);
 if(!digits)return '';
 return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,digits)).slice(0,22);
}

/** 本次写入 Lead 的、由 Plenti 提供的联系方式 {字段名: 指纹}。 */
function plSuppliedContacts_(parsed){
 var out={},phone=parsed&&parsed.customer&&parsed.customer.phone;
 if(phone)out[plPhoneField_(phone)]=plContactHash_(phone);
 return out;
}

var PLENTI_MERGE_FIELDS=['name','phone','address','systems'];

function plSameValue_(key,a,b){
 if(key==='phone')return plNormalizeDigits_(a)===plNormalizeDigits_(b);
 return String(a).replace(/\s+/g,' ').trim().toLowerCase()===String(b).replace(/\s+/g,' ').trim().toLowerCase();
}

/**
 * plMergeSources_(fromEmail, fromPage) → {fields, source, conflicts}
 *
 * 两个数据源逐字段合并(D-029):
 *
 *   只有一边有值  → 取那一边
 *   两边都有且一致 → 取值,来源记 both
 *   两边都有且冲突 → **以邮件为准**,并记入 conflicts,要人看一眼
 *
 * 为什么冲突时邮件优先:
 *   1. 邮件是**我们在 T0 实际收到的那一份**,落在 Plenti_Raw_Email__c,是审计原件
 *   2. 邮件不受网络影响;页面是事后另外抓的,抓的时刻不同
 *   3. 页面在这里的角色是**独立交叉核对** —— 它的价值在于发现两边不一致,
 *      而不是在不一致时替邮件做决定
 *
 * 冲突**不阻断建 Lead**:SLA 时钟不等人。用邮件的值建,把冲突写进 reason 和
 * Description,让跟进的人看到。
 */
function plMergeSources_(fromEmail,fromPage){
 var out={fields:{},source:{},conflicts:[]},i,key,e,p;
 for(i=0;i<PLENTI_MERGE_FIELDS.length;i++){
  key=PLENTI_MERGE_FIELDS[i];
  e=(fromEmail&&fromEmail[key])||'';
  p=(fromPage&&fromPage[key])||'';
  if(e&&p){
   out.fields[key]=e;
   if(plSameValue_(key,e,p))out.source[key]='both';
   else{out.source[key]='email';out.conflicts.push(key);}
  }else if(e){out.fields[key]=e;out.source[key]='email';}
  else if(p){out.fields[key]=p;out.source[key]='page';}
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
  status:fetched.status,error:fetched.error,found:[],missing:[],
  emailFound:[],pageFound:[],sources:{},conflicts:[],degraded:false,auditMissing:false};
 parsed.browserView=meta;
 if(!fetched.token){
  meta.degraded=true;
  parsed.reason='No Plenti browser-view link found in the message; '+parsed.reason;
  return {html:'',meta:meta};
 }
 // 有 token 就有稳定身份 —— 这是 Plenti 转介,后面无论如何都要建 Lead。
 parsed.kind='referral';
 if(!parsed.referralId)parsed.referralId=fetched.token;

 // [R17] 两个数据源(D-029)。邮件 HTML 与 browser view 是**同一个 Customer.io
 // 模板**的两份渲染,所以用同一个解析器,双区块陷阱的处理自动两边都适用。
 // 刻意不解析 getPlainBody():那是 Gmail 转出来的文本,格式没见过,写规则是猜。
 var fromEmail=plParseBrowserView_(message.getBody());
 var fromPage=fetched.ok?plParseBrowserView_(fetched.html):null;
 meta.emailFound=fromEmail.found;
 meta.pageFound=fromPage?fromPage.found:[];
 // 抓取照做,无论邮件解析得多完整:页面 HTML 是审计留底(D-014),不能省;
 // 它也是发现"两边不一致"的唯一交叉核对。
 meta.auditMissing=!fetched.ok;

 var merged=plMergeSources_(fromEmail,fromPage),f=merged.fields,i,key;
 meta.sources=merged.source;
 meta.conflicts=merged.conflicts;
 for(i=0;i<PLENTI_MERGE_FIELDS.length;i++){
  key=PLENTI_MERGE_FIELDS[i];
  if(f[key])meta.found.push(key);else meta.missing.push(key);
 }
 if(f.systems)parsed.systems=f.systems;
 if(f.name)parsed.customer.lastName=f.name;
 // 原样存,不规范化(D-029)。规范化只在比较时做。
 if(f.phone)parsed.customer.phone=String(f.phone).trim();
 if(f.address){
  var address=plSplitAuAddress_(f.address);
  parsed.customer.addressRaw=f.address;
  parsed.customer.street=address.street;
  parsed.customer.city=address.city;
  parsed.customer.state=address.state;
  parsed.customer.postcode=address.postcode;
 }

 // [R17] "降级"拆成两根独立的轴,以前它们是捆在一起的(抓取失败 = 没数据):
 //   degraded     —— **数据**缺失:两个来源都没给出客户姓名
 //   auditMissing —— **审计留底**缺失:页面没抓到
 // 邮件解析成功而页面抓取失败时,只丢审计留底、不丢数据 —— 比以前温和得多。
 var notes=[];
 if(f.name){
  parsed.confidence='high';
  notes.push('Parsed '+meta.found.length+' field(s)');
 }else{
  meta.degraded=true;
  parsed.confidence='low';
  notes.push('Neither the email nor the browser view yielded a customer name; open the link manually for customer details');
 }
 if(merged.conflicts.length)notes.push('⚠️ email and browser view DISAGREE on: '+merged.conflicts.join(', ')+' — the email value was used, please check');
 if(meta.auditMissing)notes.push('browser view could not be fetched ('+fetched.error+'), so the audit copy is missing'+(f.name?' — customer data came from the email':''));
 parsed.reason=notes.join('; ');
 return {html:fetched.ok?fetched.html:'',meta:meta};
}

/**
 * plUnverifiedReview_(message, baseReason) → {leadCandidate, scope, reason}
 *
 * **Q10 收窄(D-027)。** 决定一封"没能确认为可信 Plenti 发件人"的邮件要不要
 * 占用 SF-Lead-Review 标签。
 *
 * 判据是**邮件里有没有 Plenti browser-view 链接** —— 一个结构事实,
 * 与噪音量无关,所以不需要先跑几天看数据。
 *
 *   无链接 → 普通业务邮件。落 review 状态、进 Messages 表,**不打标签**。
 *   有链接 → **必须打标签**,再按原因细分措辞(scope):
 *     forwarded                 手动转发(没有 X-Original-Sender)
 *     unlisted-sender-with-link 经组投递,发件人不在可信清单(认证未评估)
 *     unverified-with-link      认证失败 —— 认证头丢了的真转介,或伪造
 *
 * ⚠️ 不违反"绝不静默丢弃":状态照常存进 Script Properties,消息照常在
 * Messages 表里留一整行(含完整正文),人看得见 —— 只是不占 Gmail 标签。
 * 设计里本来就有先例:plExclude_ 判出的测试邮件、Web-to-Lead 失败同样是
 * "review 状态但无标签"。
 *
 * ### 有链接时再分两类,只影响 reason 措辞
 *
 * 同事手动转发的 Plenti 邮件会落进"有链接"这一类 —— 它既不是漏单也不是伪造。
 * 判据是 From 在 INTERNAL_DOMAIN 上。
 *
 * ⚠️⚠️ **From 是发信人可控的,能伪造。** 所以这个区分**只用来改 reason 的措辞,
 * 绝不用来降低可见性** —— 两类的 leadCandidate 都是 true,标签照打。
 * reason 里也明说了 From 可伪造,提醒人别把它当结论。
 */
function plUnverifiedReview_(message,baseReason,source){
 if(!plBrowserViewUrl_(message)){
  return {leadCandidate:false,scope:'out-of-scope',
   reason:'Out of scope: no Plenti browser-view link in this message, so it is ordinary mailbox traffic rather than a referral. State and full body are recorded in the Messages log; no Gmail label applied. ('+baseReason+')'};
 }
 // [R18] "同事转发"必须**没有** X-Original-Sender。
 //
 // 第一封真实组投递邮件证实:发件域设了 DMARC p=REJECT 时,Google Groups 会把
 // From 改写成**组地址**(edocs@<内部域>)。所以组投递的邮件 From 永远落在内部域上,
 // 旧判据会把每一封"经组投递、但发件人不在可信清单里"的带链接邮件都标成
 // "FORWARDED BY A COLLEAGUE" —— 而且 reason 还声称"组投递的头缺失",事实上
 // 那些头都在。
 //
 // 真正的区分是投递方式:组投递带 X-Original-Sender,手动转发不带。
 // 组投递的邮件 From 没有信息量,不看它。
 var from=plAddress_(message.getFrom()),viaGroup=plHeader_(message,'X-Original-Sender')!=='';
 var internal=!viaGroup&&from!==''&&plDomain_(from)===ivInternalDomain_();
 if(internal){
  return {leadCandidate:true,scope:'forwarded',
   reason:'FORWARDED BY A COLLEAGUE ('+from+'): carries a Plenti browser-view link, and the Google Groups headers are missing because it was forwarded rather than delivered through the group — not a missed referral and not a spoof. NOTE: From can be forged, so this wording is a hint, not a verdict. ('+baseReason+')'};
 }
 // [R18] 发件人**不在清单里**和**认证失败**是两回事,措辞必须分开。
 //
 // isPlentiSource_ 先查清单(第 2 步)再查认证(第 3、4 步),所以"不在清单"
 // 时认证状态根本没被评估 —— 不能说它"可能是冒充"。第一封真实组投递邮件
 // (WA Battery Scheme)正是这种情况:DMARC 完全通过,只是那个地址不在清单里。
 //
 // 更要紧的是:**第一封真实 referral 在其发信地址被加进清单之前,也会落在这里**。
 // 所以这里把 X-Original-Sender 原样打出来 —— 系统自己告诉你该往清单里加什么。
 if(source&&source.sender&&source.reason==='Sender is not listed in PLENTI_TRUSTED_SENDERS'){
  return {leadCandidate:true,scope:'unlisted-sender-with-link',
   reason:'⚠️ SENDER NOT IN TRUSTED LIST: '+source.sender+' sent a message carrying a Plenti browser-view link. If this is a referral, add '+source.sender+' to PLENTI_TRUSTED_SENDERS. It may also be another Plenti business line using the same mail platform, or a spoof — authentication was not evaluated because the sender is unlisted. ('+baseReason+')'};
 }
 return {leadCandidate:true,scope:'unverified-with-link',
  reason:'⚠️ NEEDS A HUMAN: carries a Plenti browser-view link but the sender failed verification — either a genuine referral whose authentication headers were lost in transit, or an impersonation attempt. ('+baseReason+')'};
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
 // [R11] receivedAt 随解析结果一起落进 Plenti_Parsed_JSON__c —— 在
 // Plenti_Received_At__c 建好之前,这是收件时间唯一的留存位置(D-022)。
 var result={kind:'unknown',referralId:'',receivedAt:message.getDate().toISOString(),customer:{firstName:'',lastName:'',email:'',phone:'',street:'',city:'',state:'',postcode:''},confidence:'low',missing:[],ambiguous:[],reason:''};
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
 // receivedAt 必须带过来 —— 在 Plenti_Received_At__c 建好之前,它是收件时间
 // 唯一的留存位置(D-022),强制模式下同样不能丢。
 var id=message.getId(),forced={kind:'referral',customer:{},confidence:'high',missing:[],ambiguous:[],
  receivedAt:parsed.receivedAt||message.getDate().toISOString(),
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
 // [R14] created 表示"**这封邮件**建了这条 Lead",是持久语义,不是"这一轮建了"。
 // SF-Lead-Created 标签靠它,而 ivSyncLabels_ 每轮按持久状态重算 —— 标志丢了
 // 标签就会被主动摘掉(ivLabel_ 的 add=false 走 removeLabel)。
 //
 // ⚠️ 判据是 **Description 里有没有本邮件的 marker**,不是"走了哪条分支"。
 // 模板在 marker 分支上重新断言 created:true(Legacy.gs:81),但那条分支在
 // Plenti 路径上**不可达**:token 查询在它之前返回,而它本身还被
 // `if(parsed.customer.email)` 挡着,Plenti 从不提供客户邮箱。
 //
 // token 命中分两种,必须分开:
 //   同一封邮件重跑     → 命中的 Lead 的 Description 带本邮件 marker → created
 //   同一转介重发的新邮件 → 不带 → 保持 false,只亮 Review,让人看一眼是不是重复
 if(byReferral)return {lead:byReferral,created:String(byReferral.Description||'').indexOf(marker)>=0};
 // 第 1 层 邮件级:Description 里的 [Intake: msgId] 标记。token 查询已经覆盖
 // 绝大多数情况,这一层是 Plenti_Lead_ID__c 尚未建好时的退路(D-013)。
 if(parsed.customer.email){
  var leads=ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Email='"+ivQuote_(String(parsed.customer.email).toLowerCase())+"'");
  var sourced=leads.filter(function(l){return String(l.Description||'').indexOf(marker)>=0;});
  // 同上:marker 命中就说明这封邮件是这条 Lead 的来源(模板 Legacy.gs:81 同款)
  if(sourced.length===1)return {lead:sourced[0],created:true};
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
/**
 * [R12] **可选** Lead 字段:org 里有就写,没有就跳过,**绝不让整个 POST 失败**。
 *
 * Salesforce 是全有全无,一个字段不存在整个请求就失败(D-022)。沙箱已经建好
 * Plenti_Received_At__c,生产还没建 —— 切生产时不能被它卡住。
 *
 * ⚠️ 为什么用 describe 探测而不是 Script Property 开关(D-023):
 * 开关的**两种默认值都不安全**。默认关 → 生产建好字段后没人记得打开,
 * PLT001 的计时字段静默为空,而这是合同 SLA 的计算依据;默认开 → 切生产
 * 当天直接被 INVALID_FIELD 卡死。探测则两边都自洽,且不需要任何人记得做什么。
 */
var PLENTI_OPTIONAL_LEAD_FIELDS=['Plenti_Received_At__c','Plenti_Systems__c'];

/**
 * Lead 字段表 {字段名: 是否可写},**按执行缓存**(与模板 ivReq_.token 同一手法)。
 *
 * 一次 Apps Script 执行只发一个 describe;只在真的要建 Lead 时才触发,
 * 没有新线索的那些轮次一次请求都不发。
 *
 * describe 本身失败时返回空表并记住失败 —— 结果是**跳过可选字段但照常建 Lead**。
 * SLA 时钟不等人,宁可少一个字段也不能不建(收件时间仍在 Plenti_Parsed_JSON__c 里)。
 */
function plLeadFieldMap_(){
 if(plLeadFieldMap_.cache)return plLeadFieldMap_.cache;
 var map={};
 try{
  var data=ivReq_('sobjects/Lead/describe'),list=(data&&data.fields)||[],i,f;
  for(i=0;i<list.length;i++){
   f=list[i];
   map[f.name]={createable:f.createable===true,unique:f.unique===true,
    caseSensitive:f.caseSensitive===true,externalId:f.externalId===true,
    type:f.type||'',length:f.length||0,picklist:plActivePicklist_(f)};
  }
 }catch(e){
  console.log('Lead describe failed; optional fields are skipped for this run: '+String(e.message||e).slice(0,200));
 }
 plLeadFieldMap_.cache=map;
 return map;
}

/** 字段的**活跃** picklist 值;非 picklist 字段返回空数组。 */
function plActivePicklist_(field){
 var out=[],values=(field&&field.picklistValues)||[],i;
 for(i=0;i<values.length;i++){if(values[i]&&values[i].active!==false)out.push(values[i].value);}
 return out;
}

/**
 * [R17] LeadSource 的值从 Script Property 读,不写死(D-029)。
 *
 * 触发:生产上 Lily 加的 picklist 值是 "Plenti Referrals",代码里写死的是
 * "Plenti"。沙箱和生产不一定一样,写死迟早出事。
 *
 * 缺失即抛错(规格 §3 禁止 #2)。
 */
function plLeadSource_(){
 var value=String(PropertiesService.getScriptProperties().getProperty('PLENTI_LEAD_SOURCE')||'').trim();
 if(!value)throw new Error('Configure PLENTI_LEAD_SOURCE with the exact LeadSource picklist value for this org (production uses "Plenti Referrals")');
 return value;
}

function plLeadFieldExists_(name){var f=plLeadFieldMap_()[name];return !!f&&f.createable===true;}

/**
 * 取 LeadSource 并对照 org 的 picklist 校验。
 *
 * ⚠️ 由 plCreateLead_ 在**写 IV2_CREATE_ 锁之前**调用。所以配错的 LeadSource
 * 会在上锁之前就抛出来 —— 不会先 POST 失败、再把锁卡在 requested 触发 L-01
 * (那要人工删属性才能恢复)。
 *
 * describe 失败时(字段表为空)跳过校验,不阻断 —— 与可选字段探测同一策略。
 */
function plValidatedLeadSource_(){
 var value=plLeadSource_(),field=plLeadFieldMap_().LeadSource;
 if(field&&field.picklist&&field.picklist.length&&field.picklist.indexOf(value)<0){
  throw new Error('PLENTI_LEAD_SOURCE "'+value+'" is not an active LeadSource picklist value in this org. Active values: '+field.picklist.join(', '));
 }
 return value;
}

var PLENTI_LONG_TEXT_LIMIT=131072;
var PLENTI_JSON_LIMIT=32768;
var PLENTI_DESCRIPTION_LIMIT=32000;

/** 截断并标注,标注算在上限之内(D-013)。 */
function plTruncateField_(value,limit){
 var text=String(value||''),marker='… [TRUNCATED]';
 return text.length<=limit?text:text.slice(0,limit-marker.length)+marker;
}

/**
 * Description 末尾的状态标记。三种情况是独立的,可以同时出现(D-029):
 *   数据缺失   —— 两个来源都没给出客户姓名,人得自己去点链接
 *   来源冲突   —— 邮件和页面对同一字段给了不同的值,用了邮件的,要人核对
 *   审计缺失   —— 页面没抓到,数据来自邮件,但 Plenti_Browser_View_HTML__c 是空的
 */
function plDescriptionFlags_(meta){
 var out='';
 if(!meta)return out;
 if(meta.degraded)out+=' [CUSTOMER DETAILS MISSING — open the browser-view link in the raw email]';
 if(meta.conflicts&&meta.conflicts.length)out+=' [SOURCES DISAGREE: '+meta.conflicts.join(', ')+' — email value used, please check]';
 if(meta.auditMissing&&!meta.degraded)out+=' [AUDIT COPY MISSING — browser view was not fetched]';
 return out;
}

function plLeadPayload_(message,parsed,enrichment){
 var c=parsed.customer,marker='[Intake: '+message.getId()+']',meta=(enrichment&&enrichment.meta)||{};
 var fieldCount=(meta.found||[]).length;
 var payload={
  LastName:plTruncateField_(c.lastName||('Plenti referral '+String(parsed.referralId||'').slice(0,24)),80),
  Status:'New',
  OwnerId:ivAdmin_(),
  LeadSource:plLeadSource_(),
  Company:'Individual / Residential',
  Contact_Attempt_Count__c:0,
  // D-014:审计留底存**原始 HTML**,不存 Gmail 转好的文本 —— 转换有损,
  // 留底若存派生物,将来发现解析漏字段就没有原文可回填了。
  Plenti_Raw_Email__c:plTruncateField_(message.getBody(),PLENTI_LONG_TEXT_LIMIT),
  Plenti_Browser_View_HTML__c:plTruncateField_((enrichment&&enrichment.html)||'',PLENTI_LONG_TEXT_LIMIT),
  Plenti_Parsed_JSON__c:plTruncateField_(JSON.stringify(parsed),PLENTI_JSON_LIMIT),
  // D-013:一行摘要,不复制原文。marker 是承重结构,不能删。
  // [R13] 摘要里带上 systems —— 跟进的人一眼要看到客户想装什么。
  // 这不违反 D-012:那条禁的是 referralId 之外的**内部标识符**,而 systems 是
  // 客户需求本身,正是 D-012 允许的"销售必要信息"。
  Description:plTruncateField_(marker+' Plenti referral received '+message.getDate().toISOString()+'; '+fieldCount+' fields parsed'+(parsed.systems?'; systems: '+parsed.systems:'')+plDescriptionFlags_(meta),PLENTI_DESCRIPTION_LIMIT)
 };
 // [R13] 专用字段:Description 是自由文本,分组和筛选都做不了。Schedule 3 季度
 // 报告和 PLT002 的转化率分析都可能要按系统类型切分,所以另建一个可报表字段。
 // 字段还没建时按 D-023 自动跳过,Description 里的那份保证信息不会不可见。
 if(parsed.systems&&plLeadFieldExists_('Plenti_Systems__c'))payload.Plenti_Systems__c=plTruncateField_(parsed.systems,255);
 // [R12] PLT001 SLA 的计时起点(规格 §5.3)。
 // ⚠️ 值**必须**取自 message.getDate() —— 邮件的接收时间,**不是脚本运行时间**。
 // 取错了整个 SLA 统计都是错的,而且事后无法从记录里还原。这里刻意直接取
 // message.getDate(),不经过 parsed.receivedAt,少一层被污染的可能。
 // 规格 §5.3 明确不用 CreatedDate:轮询是 10–15 分钟一次,创建时间必然晚于
 // 接收时间,而"有 error 则 watermark 不前移"会把这个偏差放大。
 // 字段不存在时跳过(见 PLENTI_OPTIONAL_LEAD_FIELDS),收件时间仍在
 // Plenti_Parsed_JSON__c 的 receivedAt 里,不会丢。
 if(plLeadFieldExists_('Plenti_Received_At__c'))payload.Plenti_Received_At__c=message.getDate().toISOString();
 // 解析不到 delivery token 就**不传该字段**(R8 第 4 点)。
 if(parsed.referralId)payload.Plenti_Lead_ID__c=parsed.referralId;
 // §5.2:客户邮箱取不到就不写,**绝不拿 Plenti 的地址兜底**。
 if(c.email)payload.Email=c.email;
 if(c.firstName)payload.FirstName=plTruncateField_(c.firstName,40);
 // [R17] 手机进 MobilePhone、其余进 Phone(D-029)。原样写入,不规范化;
 // Phone / MobilePhone 在 Salesforce 里上限都是 40 字符。
 if(c.phone)payload[plPhoneField_(c.phone)]=plTruncateField_(String(c.phone).trim(),40);
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
 // [R17] 在上锁**之前**校验 LeadSource。配错的值在这里就抛出来,不会先 POST
 // 失败、再把锁卡在 requested 触发 L-01。放在这里而不是 plLeadPayload_ 里,
 // 是因为字段自检的探针也调 plLeadPayload_ —— 自检工具不能在配错时自己崩掉,
 // 它的用处恰恰是把配错报出来。
 plValidatedLeadSource_();
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
 * review 状态的解除条件 —— 返回解除理由,或空串表示还不能解除。
 *
 * **主信号:Lead 上出现了任何一种联系方式。**
 *
 * 这个信号之所以干净,是因为 **Plenti 一条联系方式都不给**(D-024):邮件正文、
 * browser view 页面全文搜索过,电话和邮箱 0 处命中。联系方式只存在于 Plenti
 * Portal,而 Portal 每次登录都要双重验证、账号还是发给老板个人的,自动化不现实。
 * 所以 `Email` / `Phone` / `MobilePhone` 里任何一个变成非空,**只可能是人填的**。
 *
 * 另外两个条件沿用模板 ivRefreshReview_ 的意图:线索被转换、或被判定为
 * Unqualified,都说明有人处理过了,再挂着 review 只是噪音。
 */
function plReviewClearedReason_(lead,supplied){
 supplied=supplied||{};
 if(lead.IsConverted===true)return 'Lead has been converted';
 if(lead.Status==='Unqualified')return 'Lead marked Unqualified';
 // [R17] D-024 的前提"Plenti 一条联系方式都不给,所以非空只可能是人填的"
 // 已经**不成立** —— 正式 lead 带了 Customer phone。如果照旧,我们自己写进去
 // 的电话会在下一轮就让 review 解除,而且 reason 会谎称"是人填的"。
 //
 // 所以现在的判据是:**这个值不是我们写进去的**。supplied 里记着我们写入时的
 // 指纹;同一个号码(换格式也算)不算人为动作,人改了号码或补了邮箱才算。
 var fields=['Email','Phone','MobilePhone'],i,name,value;
 for(i=0;i<fields.length;i++){
  name=fields[i];value=lead[name];
  if(!value)continue;
  if(supplied[name]&&supplied[name]===plContactHash_(value))continue;
  return 'Contact details were added or changed by a person ('+name+')';
 }
 return '';
}

/**
 * plRefreshReview_(message) —— review 状态的自动解除(关闭 Q9)。
 *
 * 由 runIntakeV2 的消息循环和 ivRefreshOutstanding_ 每轮调用,管道本来就铺好了,
 * 这里只是把空桩换成实现。
 *
 * ### 它带来的两态工作流
 *
 * 不需要新标签,现有标签对就能表达 Jack 要的两个状态:
 *
 *   Created + Review   →  待补联系方式(每条 Plenti 线索的必经状态)
 *   Created(Review 消失)→  已补全
 *
 * ### 成本:只查真正需要轮询的那些
 *
 * 前三行守卫决定了**只有"已建出 Lead 且仍在 review"的消息才会发 SOQL**。
 * 不可信噪音邮件的 review 状态没有 record,一次查询都不会发 —— 这一点在
 * 进组之后尤其要紧(Q10)。
 *
 * 字段列表刻意写死成最小集,不用 ivLeadFields_():查得更便宜,也避开
 * StateCode 那类条件字段的坑(D-022)。
 *
 * ### 查询失败绝不中断主流程
 *
 * runIntakeV2 的主循环调用这里时**没有包 try/catch**,抛出去会让整轮死掉。
 * 状态刷新失败只是标签晚点摘,建 Lead 和 SLA 时钟才是要紧的 —— 记日志后返回。
 */
function plRefreshReview_(message){
 var id=message.getId(),state=ivGet_(id);
 if(!state||state.state!=='review')return false;
 if(!state.record||!/^00Q/.test(state.record))return false;
 var lead;
 try{
  lead=ivQuery_("SELECT Id,Email,Phone,MobilePhone,Status,IsConverted FROM Lead WHERE Id='"+ivQuote_(state.record)+"'")[0];
 }catch(e){
  console.log('Review refresh could not read Lead '+state.record+': '+String(e.message||e).slice(0,200));
  return false;
 }
 if(!lead)return false;
 var reason=plReviewClearedReason_(lead,state.supplied);
 if(!reason)return false;
 state.state='done';
 state.reason=reason;
 ivSave_(id,state);
 console.log('Review cleared for message '+id+' (Lead '+state.record+'): '+reason);
 return true;
}

// ============================================================
// 字段自检 —— ⚠️ 这一节是**长期工具,不随 R3/R9/R10 删除**
// ============================================================

/**
 * 列出代码实际会读/写的 Lead 字段。
 *
 * **故意不手工维护一份字段清单** —— 那种清单一定会和代码漂移,而漂移的
 * 后果正是 R11 这次撞到的运行时 400。这里改为:
 *   读字段 ← 直接拆 plLeadFields_() 的返回值
 *   写字段 ← 拿一个把所有可选字段都填满的探针跑一遍 plLeadPayload_,取 keys
 * 这样只要 plLeadPayload_ 改了,自检自动跟着变,不会漏。
 */
function plLeadFieldsUsed_(){
 var probeMessage={
  getId:function(){return 'describe-probe';},
  getSubject:function(){return 'describe probe';},
  getDate:function(){return new Date();},
  getBody:function(){return '';},
  getPlainBody:function(){return '';}
 };
 var probeParsed={kind:'referral',referralId:'PROBE',receivedAt:new Date().toISOString(),
  customer:{firstName:'A',lastName:'B',email:'probe@example.invalid',phone:'0400000000',
   street:'1 Probe St',city:'Probe',state:'sa',postcode:'5000'},
  confidence:'high',missing:[],ambiguous:[],reason:'probe'};
 var payload=plLeadPayload_(probeMessage,probeParsed,{html:'',meta:{found:[]}});
 var usage={},optional={},read=plLeadFields_().split(','),write=Object.keys(payload),out=[],i,name;
 for(i=0;i<read.length;i++){name=read[i].replace(/\s+/g,'');if(name)usage[name]='read';}
 for(i=0;i<write.length;i++){name=write[i];usage[name]=usage[name]?'read+write':'write';}
 // [R12] 可选字段无论探测结果如何都要列出来 —— 自检要覆盖"代码可能碰到的"
 // 全集,否则探测失败时它会从清单里消失,正好躲开检查。
 for(i=0;i<PLENTI_OPTIONAL_LEAD_FIELDS.length;i++){
  name=PLENTI_OPTIONAL_LEAD_FIELDS[i];
  optional[name]=true;
  if(!usage[name])usage[name]='write';
 }
 for(name in usage){if(Object.prototype.hasOwnProperty.call(usage,name))out.push({name:name,usage:usage[name],optional:optional[name]===true});}
 return out;
}

/**
 * plTestDescribeLead() —— 开发期字段自检。
 *
 * 取 Salesforce 的 Lead describe,和代码实际用到的字段比对,列出
 * **"代码要用但这个 org 里没有"** 的字段。
 *
 * 为什么需要:这类错误的表现是运行时 400(`INVALID_FIELD: No such column`),
 * 排查成本高,而且 **Salesforce 是全有全无 —— 一个字段不存在整个请求就失败**。
 * 切生产时也用得上:生产的字段和沙箱不一定一样。
 *
 * ⚠️ 函数名**没有**下划线后缀。Apps Script 编辑器的 Run 下拉框不会列出以
 * `_` 结尾的函数,叫 `plTestDescribeLead_` 就点不着了。
 *
 * 只读:只发一个 describe 请求,不写任何记录。
 */
function plTestDescribeLead(){
 // 走与运行期同一条缓存,避免多发一个 describe,也顺带验证那条路径本身能用。
 plLeadFieldMap_.cache=null;
 var have=plLeadFieldMap_(),names=[],i,u,out;
 for(out in have){if(Object.prototype.hasOwnProperty.call(have,out))names.push(out);}
 var used=plLeadFieldsUsed_(),missing=[],optionalMissing=[],notCreateable=[];
 for(i=0;i<used.length;i++){
  u=used[i];
  if(!Object.prototype.hasOwnProperty.call(have,u.name)){
   // [R12] 可选字段缺失是**预期内的降级**,不是错误 —— 分开报,别混进红色清单
   if(u.optional)optionalMissing.push(u.name);else missing.push(u.name+' ['+u.usage+']');
   continue;
  }
  if(u.usage.indexOf('write')>=0&&have[u.name].createable!==true)notCreateable.push(u.name);
 }
 console.log('[R11] Lead exposes '+names.length+' fields in this org; the code uses '+used.length+'.');
 if(missing.length){
  console.log('[R11] ❌ MISSING — every one of these will fail the whole request: '+missing.join(', '));
 }else{
  console.log('[R11] ✅ every required field the code reads or writes exists in this org.');
 }
 if(optionalMissing.length)console.log('[R11] ⓘ optional and absent — skipped at runtime, the request still succeeds: '+optionalMissing.join(', '));
 if(notCreateable.length)console.log('[R11] ⚠️ present but NOT createable (write will fail): '+notCreateable.join(', '));

 // 两处已知的条件字段,单独点名 —— 它们不在上面的 missing 列表里也值得确认
 console.log('[R11] address picklists: StateCode='+(Object.prototype.hasOwnProperty.call(have,'StateCode')?'present':'ABSENT')+
             ', CountryCode='+(Object.prototype.hasOwnProperty.call(have,'CountryCode')?'present':'ABSENT')+
             ' (both exist only when State & Country Picklists are enabled)');
 console.log('[R11] Plenti_Received_At__c: '+(Object.prototype.hasOwnProperty.call(have,'Plenti_Received_At__c')
  ? 'PRESENT — PLT001 timestamp is written from the message date (spec 5.3)'
  : 'ABSENT — skipped at runtime; PLT001 cannot be measured from a dedicated field until it is created (spec 5.3)'));

 // [R17] PLENTI_LEAD_SOURCE 必须是 org 里的活跃 picklist 值。沙箱和生产的
 // 值可能不同(生产是 "Plenti Referrals"),写错整个 POST 就会失败。
 var configured=String(PropertiesService.getScriptProperties().getProperty('PLENTI_LEAD_SOURCE')||'').trim();
 var ls=have.LeadSource,lsValues=(ls&&ls.picklist)||[];
 if(!configured){
  console.log('[R11] ❌ PLENTI_LEAD_SOURCE is not configured — every Lead creation will stop');
 }else if(!lsValues.length){
  console.log('[R11] ⓘ PLENTI_LEAD_SOURCE="'+configured+'" — LeadSource picklist values not available from describe, cannot verify');
 }else if(lsValues.indexOf(configured)<0){
  console.log('[R11] ❌ PLENTI_LEAD_SOURCE="'+configured+'" is NOT an active LeadSource value in this org. Active values: '+lsValues.join(', '));
 }else{
  console.log('[R11] ✅ PLENTI_LEAD_SOURCE="'+configured+'" is an active LeadSource value in this org');
 }

 // [R14] Plenti_Lead_ID__c 的三个属性 —— 人肉核对不算数,让 describe 说话。
 // Unique 是规格 §5.4 第三层去重的**数据库层兜底**:查询与创建之间存在竞态
 // 窗口,跨项目又无法原子去重(§5.5),没有这条约束这一层就只剩"先查再建"。
 var key=have.Plenti_Lead_ID__c;
 if(!key){
  console.log('[R11] ❌ Plenti_Lead_ID__c is ABSENT — business-level deduplication cannot work at all (spec 5.4)');
 }else{
  console.log('[R11] Plenti_Lead_ID__c: type='+key.type+'('+key.length+') unique='+key.unique+
              ' caseSensitive='+key.caseSensitive+' externalId='+key.externalId);
  if(!key.unique)console.log('[R11] ⚠️⚠️ Plenti_Lead_ID__c is NOT unique — spec 5.4 layer 3 has no database backstop. The query-then-create window can produce duplicate Leads, and cross-project deduplication is impossible anyway (spec 5.5).');
  if(key.unique&&!key.caseSensitive)console.log('[R11] ⚠️ unique but NOT case sensitive — delivery tokens are base64, so two distinct tokens differing only in case would collide and the second referral would be silently skipped.');
  if(!key.externalId)console.log('[R11] ⓘ not an External ID — upsert by external id (task B) is unavailable until it is.');
 }

 return {missing:missing,optionalMissing:optionalMissing,notCreateable:notCreateable,used:used.length,available:names.length};
}

// ============================================================
// R9 离线注入测试入口 + R10 发件人覆盖 —— ⚠️ Phase 4 后整节删除(与 R3 一起)
// ============================================================

/**
 * ⚠️⚠️ [R10 临时] 测试用发件人覆盖。DECISIONS D-021,与 R3 / R9 一起删。
 *
 * **只有 plTestFromMessageId 读这个属性。主流程 runIntakeV2 / plProcess_
 * 完全不读**,由两道断言锁住:一道静态检查(Code.gs 里不得出现这个属性名),
 * 一道行为检查(属性设上之后 plProcess_ 的判定结果一个字都不变)。
 *
 * 实现方式是**包一层 message**,而不是在主流程里加分支 —— plProcess_ 及其
 * 下游一个字节都没改,它们只是收到一个 getHeader 行为不同的对象。
 */
function plTestSenderOverride_(){
 return String(PropertiesService.getScriptProperties().getProperty('PLENTI_TEST_SENDER_OVERRIDE')||'').trim().toLowerCase();
}

/**
 * ⚠️⚠️ [R10 临时] 把邮件包一层,伪造 §5.1 需要的两个头。
 *
 * **这不只是覆盖发件人,它伪造了整条发件人可信验证链。** 光给
 * X-Original-Sender 不够:转发件同样没有 X-Original-Authentication-Results,
 * isPlentiSource_ 会卡在第 3 步。所以这里在**真实头缺失时**补一个
 * dmarc=pass —— 真实头存在时原样透传,不覆盖真值。
 *
 * 换句话说:开着这个属性时,规格 §5.1 的可信验证**整个是假的**。
 * 它只用来在组建好之前把后续环节跑通,进组之后必须单独补测这一环。
 * 属性没设时这层包装根本不存在,主流程行为与之前完全一致。
 */
function plTestOverrideMessage_(message,sender){
 var domain=plDomain_(sender);
 return {
  getId:function(){return message.getId();},
  getSubject:function(){return message.getSubject();},
  getFrom:function(){return message.getFrom();},
  getDate:function(){return message.getDate();},
  getPlainBody:function(){return message.getPlainBody();},
  getBody:function(){return message.getBody();},
  getRawContent:function(){return message.getRawContent();},
  getThread:function(){return message.getThread();},
  getHeader:function(name){
   var key=String(name||'');
   if(key==='X-Original-Sender')return sender;
   if(key==='X-Original-Authentication-Results'){
    var real=String(message.getHeader(key)||'');
    return real||('test-override; dmarc=pass header.from='+domain);
   }
   return message.getHeader(key);
  }
 };
}

/** ⚠️ [R10 临时] 建完之后回读五个自定义字段,只打长度不打内容(其中两个是 40KB HTML)。 */
function plTestVerifyLead_(recordId){
 // [R12] 可选字段存在才查 —— 查一个不存在的字段会让整条 SOQL 报错(D-022)。
 // [R13] 带上 Name/FirstName/LastName —— Lead 页面上的 Name 是复合字段,
 // 布局怎么显示不代表记录里是什么。回读一次才是权威答案。
 var fields=['Name','FirstName','LastName','Plenti_Lead_ID__c','Plenti_Raw_Email__c','Plenti_Browser_View_HTML__c','Plenti_Parsed_JSON__c','Contact_Attempt_Count__c'],i;
 for(i=0;i<PLENTI_OPTIONAL_LEAD_FIELDS.length;i++){
  if(plLeadFieldExists_(PLENTI_OPTIONAL_LEAD_FIELDS[i]))fields.push(PLENTI_OPTIONAL_LEAD_FIELDS[i]);
 }
 try{
  var row=ivQuery_("SELECT "+fields.join(',')+" FROM Lead WHERE Id='"+ivQuote_(recordId)+"'")[0];
  if(!row){console.log('[R10] verify: Lead '+recordId+' could not be read back');return;}
  var v;
  for(i=0;i<fields.length;i++){
   v=row[fields[i]];
   console.log('[R10] verify '+fields[i]+': '+(v===null||v===undefined||v===''?'(EMPTY)':(String(v).length>120?String(v).length+' chars':String(v))));
  }
 }catch(e){
  console.log('[R10] verify failed (field may not exist in this org): '+String(e.message||e).slice(0,300));
 }
}

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

  // ⚠️⚠️ [R10 临时] 发件人覆盖。只在这个入口里生效。
  var override=plTestSenderOverride_();
  if(override){
   if(override.indexOf('@')<0)throw new Error('PLENTI_TEST_SENDER_OVERRIDE must be an email address, got: '+override);
   if(plDomain_(override)===ivInternalDomain_())throw new Error('PLENTI_TEST_SENDER_OVERRIDE is set to an address on INTERNAL_DOMAIN ('+ivInternalDomain_()+'). The message would be classified internal and skipped. Use the real Plenti sender address instead.');
   console.log('[R10] ⚠️⚠️ 发件人被测试覆盖为 '+override+' — 原 X-Original-Sender: '+(plHeader_(message,'X-Original-Sender')||'(absent)'));
   console.log('[R10] ⚠️⚠️ This FAKES THE WHOLE OF §5.1 sender verification, not just the sender. X-Original-Authentication-Results is synthesised when absent. Sender trust must still be tested separately once the group exists.');
   if(!plSenderTrusted_(override,plTrustedSenders_()))console.log('[R10] ⚠️ heads-up: '+override+' is NOT in PLENTI_TRUSTED_SENDERS — verification will still fail at step 2.');
   message=plTestOverrideMessage_(message,override);
  }

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
  // [R9] detail 为空 ⇒ plProcess_ 在开头就短路了(已处理过且不是 error 状态),
  // 这一轮**根本没跑解析、也没发起抓取**。以前这里会打成 "ok=false status=0",
  // 看起来像抓取失败 —— 那是误导,D-028。
  var reprocessed=!!detail.parsed;
  console.log('[R9] result: state='+state.state+' kind='+state.kind+' record='+(state.record||'(none)'));
  if(!reprocessed){
   console.log('[R9] ⏭️ NOT RE-PROCESSED — this message already has a stored state, so plProcess_ returned it unchanged.');
   console.log('[R9] ⏭️ Nothing was parsed and no page was fetched this run. The values below come from the earlier run. Pass force=true to actually re-run.');
  }else{
   var view=detail.parsed.browserView||{};
   console.log('[R9] createdNow='+(state.createdNow===true)+' createdByThisMessage='+(state.created===true));
   console.log('[R9] browser view: ok='+(view.ok===true)+' status='+(view.status||0)+' degraded='+(view.degraded===true)+' fields='+((view.found||[]).join(',')||'(none)')+(view.error?' error='+view.error:''));
  }
  console.log('[R9] reason: '+state.reason);

  try{ivSyncLabels_(message.getThread());}catch(e){console.log('[R9] label sync failed (not fatal): '+String(e.message||e).slice(0,200));}

  // [R9] 短路时本轮什么都没做:processed 记 0,created 记 0。
  // createdNow 是**持久化**在状态里的,短路后照样读得到 —— 直接拿它计数会让
  // 同一条 Lead 被重复记进月度对账(D-026 拆分 created/createdNow 的同一类坑)。
  var stats={threads:1,skipped:0,processed:reprocessed?1:0,
   created:(reprocessed&&state.createdNow&&state.record)?1:0,
   failed:state.state==='error'?1:0,
   errors:state.state==='error'?[id+': '+String(state.reason||'').slice(0,200)]:[],
   forced:plForceCreate_()};
  ivLogRun_(began,stats);
  ivLogMessages_([ivMessageLogRow_(message,recipient,state,detail)]);
  // ⚠️ [R10 临时] 回读五个自定义字段,方便肉眼核对写入结果。
  if(state.record)plTestVerifyLead_(state.record);
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
  if(excluded&&!excluded.unverified){
   state.kind=excluded.kind;
   state.reason=excluded.reason;
   state.leadCandidate=!!excluded.leadCandidate;
   if(excluded.kind==='review')state.state='review';
   ivSave_(id,state);
   return state;
  }
  // [R15] "没能确认为可信 Plenti 发件人"有两个入口:发件人头缺失(转发件走这条)
  // 和可信验证不通过。两者的可见性判定完全相同,合成一处,见 D-027。
  var unverified='',source=null;
  if(excluded&&excluded.unverified){
   detail.sender='';
   detail.trusted=false;
   unverified=excluded.reason;
  }else{
   source=isPlentiSource_(message);
   detail.sender=source.sender;
   detail.trusted=source.trusted;
   if(!source.trusted){
    var refined=plUntrustedReason_(message.getSubject(),message.getPlainBody());
    unverified=(refined?refined+' — ':'')+'not a verified Plenti sender: '+source.reason;
   }
  }
  if(unverified){
   var visibility=plUnverifiedReview_(message,unverified,source);
   state.kind='review';
   state.state='review';
   state.leadCandidate=visibility.leadCandidate;
   state.scope=visibility.scope;
   state.reason=visibility.reason;
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
   resolved.created=true;
   // [R14] createdNow 只表示"**本轮**真的发了 POST",给运行日志的计数和
   // reason 文案用。和持久的 created 分开 —— 混用会让月度对账多算 Lead。
   state.createdNow=true;
  }
  state.record=lead.Id;
  state.created=resolved.created===true;
  // [R17] 记下我们写进去的联系方式指纹。**按本次解析结果重算**而不是只在
  // POST 时记 —— force 重跑会新建 state 对象,只在 POST 时记的话重跑后就丢了。
  state.supplied=plSuppliedContacts_(parsed);
  state.attached=ivAttachSource_(message,{id:lead.Id});
  state.state='review';
  state.leadCandidate=true;
  state.reason=(forced?'[FORCED] ':'')+(parsed.confidence!=='high'?'[DEGRADED] ':'')+(state.createdNow?'New Plenti Lead awaiting administrator approval':'Existing Lead matched by delivery token or message marker');
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
