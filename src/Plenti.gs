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
 * │ C. parsePlentiReferral_ 仅可信邮件走到这;骨架期恒返回 unknown  │
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
function plRecipientAllowed_(message,entries){
 var i,j,addresses;
 for(i=0;i<PLENTI_RECIPIENT_HEADERS.length;i++){
  addresses=plAddresses_(plHeader_(message,PLENTI_RECIPIENT_HEADERS[i]));
  for(j=0;j<addresses.length;j++){if(plAddressMatches_(addresses[j],entries))return true;}
 }
 return false;
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
function plFindReferral_(referralId){
 throw new Error('Referral ID lookup is not implemented (blocked on Q6: where referral IDs are stored). Refusing to create a Lead without business-level deduplication. Referral ID: '+String(referralId||''));
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
function plResolve_(message,parsed){
 var email=String(parsed.customer.email||'').toLowerCase();
 if(!email)return {review:'Customer email missing; refusing to create a Lead from the sender address'};
 if(!parsed.referralId)return {review:'Plenti referral ID missing; business-level deduplication impossible'};
 var marker='[Intake: '+message.getId()+']';
 var leads=ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Email='"+ivQuote_(email)+"'");
 var sourced=leads.filter(function(l){return String(l.Description||'').indexOf(marker)>=0;});
 if(sourced.length===1)return {lead:sourced[0]};
 if(sourced.length>1)return {review:'Multiple Leads carry this message marker; manual review required'};
 var byReferral=plFindReferral_(parsed.referralId);
 if(byReferral)return {lead:byReferral,supplement:true};
 var open=leads.filter(function(l){return !l.IsConverted&&l.Status!=='Unqualified';});
 if(open.length)return {review:'Existing active Lead for this customer email; confirm same request versus a new project'};
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
function plLeadPayload_(message,parsed){
 var c=parsed.customer,marker='[Intake: '+message.getId()+']';
 var payload={
  LastName:String(c.lastName||'').slice(0,80),
  Email:c.email,
  Status:'New',
  OwnerId:ivAdmin_(),
  LeadSource:'Plenti',
  Company:'Individual / Residential',
  Contact_Attempt_Count__c:0,
  Plenti_Received_At__c:message.getDate().toISOString(),
  Description:(marker+'\nPLENTI REFERRAL - PENDING ADMIN REVIEW\nSource: '+ivSource_()+'\nPlenti referral ID: '+parsed.referralId+'\nSubject: '+String(message.getSubject()||'')+'\nRaw email body is intentionally not copied here (see DECISIONS D-012 / Q5).').slice(0,32000)
 };
 if(c.firstName)payload.FirstName=String(c.firstName).slice(0,40);
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
function plCreateLead_(message,parsed){
 var id=message.getId(),p=PropertiesService.getScriptProperties();
 if(p.getProperty('IV2_CREATE_'+id))throw new Error('Earlier create outcome is uncertain; check Salesforce before retrying creation');
 var payload=plLeadPayload_(message,parsed);
 p.setProperty('IV2_CREATE_'+id,JSON.stringify({state:'requested',at:new Date().toISOString()}));
 var result=ivReq_('sobjects/Lead','post',payload);
 p.setProperty('IV2_CREATE_'+id,JSON.stringify({state:'created',id:result.id,at:new Date().toISOString()}));
 return ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Id='"+ivQuote_(result.id)+"'")[0];
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
function plProcess_(message,force){
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
  state.kind=parsed.kind;
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
  if(parsed.kind!=='referral'||parsed.confidence!=='high'){
   state.state='review';
   state.leadCandidate=true;
   state.reason='Plenti referral could not be parsed with confidence: '+parsed.reason;
   ivSave_(id,state);
   return state;
  }
  var resolved=plResolve_(message,parsed);
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
   lead=plCreateLead_(message,parsed);
   state.created=true;
  }
  state.record=lead.Id;
  state.attached=ivAttachSource_(message,{id:lead.Id});
  state.state='review';
  state.leadCandidate=true;
  state.reason=state.created?'New Plenti Lead awaiting administrator approval':'Existing Lead matched by message marker';
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
