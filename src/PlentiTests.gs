/**
 * PlentiTests.gs —— Plenti 路径回归测试。
 *
 * 全部使用虚构数据。fixture 由 test/offline.cjs 从 test/fixtures/*.json
 * 读入并注入全局 PLENTI_FIXTURES;本文件不含任何真实客户信息,
 * 也不发起任何 Gmail / Salesforce 调用。
 *
 * 分工:message 形态的用例(邮件头才是重点)走 .json fixture;
 * 纯字符串分类用例(主题 + 发件人)用行内表格,与 Tests.gs 的既有风格一致。
 *
 * 入口:runPlentiRegressionTests()
 */

// ============================================================
// 测试基础设施
// ============================================================

function plAssert_(condition,message){if(!condition)throw new Error('ASSERT: '+message);}

function plAssertEq_(actual,expected,message){
 if(actual!==expected)throw new Error('ASSERT: '+message+' — got '+JSON.stringify(actual)+', expected '+JSON.stringify(expected));
}

function plAssertThrows_(fn,pattern,message){
 var threw=false,text='';
 try{fn();}catch(e){threw=true;text=String(e.message||e);}
 if(!threw)throw new Error('ASSERT: '+message+' — expected a throw, got none');
 if(!pattern.test(text))throw new Error('ASSERT: '+message+' — thrown message did not match '+pattern+': '+text);
}

function plFixtures_(){
 if(typeof PLENTI_FIXTURES==='undefined')throw new Error('Fixtures are injected by test/offline.cjs. Run: node test/offline.cjs');
 return PLENTI_FIXTURES;
}

/** 由 fixture 名构造邮件 mock。 */
function plTestMessage_(name){
 var f=plFixtures_()[name];
 if(!f)throw new Error('Unknown fixture: '+name);
 return plTestMessageFrom_(f);
}

/** 由行内对象构造邮件 mock,形状与 fixture 相同。 */
function plTestMessageFrom_(f){
 return {
  getId:function(){return f.id;},
  getSubject:function(){return f.subject||'';},
  getFrom:function(){return f.from||'';},
  getDate:function(){return new Date(f.date||'2026-09-07T00:00:00.000Z');},
  getPlainBody:function(){return f.body||'';},
  getHeader:function(n){var h=f.headers||{};return Object.prototype.hasOwnProperty.call(h,n)?h[n]:'';},
  getRawContent:function(){throw new Error('getRawContent must not be called in offline tests');},
  getThread:function(){throw new Error('getThread must not be called in offline tests');}
 };
}

function plTestSetProps_(obj){
 var p=PropertiesService.getScriptProperties();
 Object.keys(obj).forEach(function(k){if(obj[k]===null)p.deleteProperty(k);else p.setProperty(k,obj[k]);});
}

/** 每个测试开头调用,保证起点一致。全部为虚构值。 */
function plTestBaseline_(){
 plTestSetProps_({
  PLENTI_TRUSTED_SENDERS:'@plenti.example, referrals@partner.example',
  INTERNAL_DOMAIN:'example.org',
  EDOCS_GROUP_ADDRESS:'edocs@example.org',
  INTAKE_MAILBOX:'edocs-copy@example.org',
  INTAKE_ADMIN_ID:'005000000000000AAA',
  ATTACH_RAW_EMAIL:null
 });
 plTestClearState_();
}

/** 清掉运行时状态属性,让每个用例互不影响。 */
function plTestClearState_(){
 var p=PropertiesService.getScriptProperties(),all=p.getProperties();
 Object.keys(all).forEach(function(k){if(k.indexOf('IV2_')===0)p.deleteProperty(k);});
}

/**
 * 用假的 Salesforce 层跑一段逻辑,记录全部调用。
 * UrlFetchApp 的桩仍然会抛错 —— 这里替换的是它上面一层,任何漏网的
 * 真实请求都会立刻炸出来,不会静默走出去。
 */
function plTestWithFakeApi_(fn){
 var realReq=ivReq_,realQuery=ivQuery_,calls=[];
 ivReq_=function(path,method,data){calls.push({kind:'req',path:path,method:method||'get',data:data});return {id:'00Qfixture000001AAA'};};
 ivQuery_=function(q){
  calls.push({kind:'query',query:q});
  if(/WHERE Id='/.test(q))return [{Id:'00Qfixture000001AAA',Description:'',IsConverted:false,Status:'New'}];
  return [];
 };
 try{return fn(calls);}finally{ivReq_=realReq;ivQuery_=realQuery;}
}

function plTestPosts_(calls){return calls.filter(function(c){return c.kind==='req'&&c.method==='post';});}

/** 一个通过解析的虚构转介,用于绕过骨架期的空正则测试下游逻辑。 */
function plTestParsed_(){
 return {kind:'referral',referralId:'FIXTURE-0001',
  customer:{firstName:'Dale',lastName:'Example',email:'dale.example@example.net',phone:'0400000001',street:'12 Fictional Street',city:'Sampletown',state:'sa',postcode:'5000'},
  confidence:'high',missing:[],ambiguous:[],reason:'Parsed as referral'};
}

// ============================================================
// 1. 发件人可信验证(规格 §5.1)
// ============================================================

function testPlentiSourceTrust(){
 plTestBaseline_();
 var cases=[
  ['trusted-referral',true,/DMARC pass/],
  ['trusted-noreply',true,/DMARC pass/],
  ['trusted-with-promo-footer',true,/DMARC pass/],
  ['spoofed-plenti',false,/not listed in PLENTI_TRUSTED_SENDERS/],
  ['unlisted-sender-dmarc-pass',false,/not listed in PLENTI_TRUSTED_SENDERS/],
  ['lookalike-domain',false,/not listed in PLENTI_TRUSTED_SENDERS/],
  ['suffix-domain',false,/not listed in PLENTI_TRUSTED_SENDERS/],
  ['subdomain-sender',false,/not listed in PLENTI_TRUSTED_SENDERS/],
  ['auth-header-missing',false,/X-Original-Authentication-Results header missing/],
  ['original-sender-missing',false,/X-Original-Sender header missing/],
  ['header-from-mismatch',false,/header\.from domain does not match/]
 ];
 cases.forEach(function(c){
  var r=isPlentiSource_(plTestMessage_(c[0]));
  plAssertEq_(r.trusted,c[1],c[0]+' trusted flag');
  plAssert_(c[2].test(r.reason),c[0]+' reason should match '+c[2]+', got: '+r.reason);
 });

 // 可信清单命中,但 DMARC 未通过 —— 第 4 步的严格判定
 var dmarcFail=isPlentiSource_(plTestMessageFrom_({
  id:'inline-dmarc-fail',subject:'New customer referral',date:'2026-09-07T03:10:00.000Z',
  headers:{'X-Original-Sender':'referrals@plenti.example',
           'X-Original-Authentication-Results':'mx.example.org; dkim=pass; spf=pass; dmarc=fail header.from=plenti.example'},
  body:'Referral reference: FIXTURE-0011\n'}));
 plAssertEq_(dmarcFail.trusted,false,'listed sender with dmarc=fail must not be trusted');
 plAssert_(/DMARC did not pass/.test(dmarcFail.reason),'dmarc=fail reason');

 // 只有 spf=pass / dkim=pass 而无 dmarc=pass 也不放行(D-009 严格版)
 var spfOnly=isPlentiSource_(plTestMessageFrom_({
  id:'inline-spf-only',subject:'New customer referral',date:'2026-09-07T03:11:00.000Z',
  headers:{'X-Original-Sender':'referrals@plenti.example',
           'X-Original-Authentication-Results':'mx.example.org; dkim=pass; spf=pass smtp.mailfrom=plenti.example'},
  body:'Referral reference: FIXTURE-0012\n'}));
 plAssertEq_(spfOnly.trusted,false,'spf/dkim pass without dmarc=pass must not be trusted');

 // 显示名与主题写着 Plenti 不构成任何证据
 var spoof=plTestMessage_('spoofed-plenti');
 plAssert_(/Plenti/.test(spoof.getFrom())&&/Plenti/.test(spoof.getSubject()),'fixture should claim Plenti in display name and subject');
 plAssertEq_(isPlentiSource_(spoof).trusted,false,'display name and subject must not confer trust');

 console.log('PASS: 11 source-trust fixtures, 2 DMARC strictness cases, 1 spoofing case');
}

// ============================================================
// 2. 可信清单的域名边界(不得用子串匹配)
// ============================================================

function testPlentiTrustedSenderBoundary(){
 plTestBaseline_();
 var entries=['@plenti.example','referrals@partner.example'];
 var cases=[
  ['referrals@plenti.example',true,'exact domain entry'],
  ['REFERRALS@PLENTI.EXAMPLE',true,'case insensitive'],
  ['referrals@partner.example',true,'exact address entry'],
  ['referrals@evil-plenti.example',false,'lookalike prefix must not match on a substring'],
  ['referrals@plenti.example.attacker.example',false,'trusted domain used as a prefix must not match'],
  ['referrals@mail.plenti.example',false,'subdomain is not automatically trusted'],
  ['referrals@xplenti.example',false,'no domain-boundary bypass'],
  ['other@partner.example',false,'address entry must not widen to the whole domain'],
  ['',false,'empty address'],
  ['not-an-address',false,'unparsable address']
 ];
 cases.forEach(function(c){plAssertEq_(plSenderTrusted_(c[0],entries),c[1],c[2]+' ('+c[0]+')');});
 console.log('PASS: 10 trusted-sender boundary cases');
}

// ============================================================
// 3. 排除规则(移植自模板 ivClassify_ 前半段)
// ============================================================

function testPlentiExclusions(){
 plTestBaseline_();
 var cases=[
  ['staff@example.org','Weekly internal update','internal'],
  ['noreply@notice.salesforce.com','Please follow up Your Unconverted Lead - Example Customer','ignore'],
  ['noreply@notice.salesforce.com','Salesforce could not create this lead','review'],
  ['someone@other.example','TEST2 referral batch','review'],
  ['mailer-daemon@other.example','Returned mail: see transcript','ignore'],
  ['postmaster@other.example','Undeliverable message','ignore'],
  ['someone@other.example','Out of office','ignore'],
  ['someone@other.example','Delivery Status Notification (Failure)','ignore'],
  ['someone@other.example','Automatic reply: annual leave','ignore']
 ];
 cases.forEach(function(c){
  var r=plExclude_(c[1],c[0]);
  plAssert_(r,'expected exclusion for '+c[1]);
  plAssertEq_(r.kind,c[2],'exclusion kind for "'+c[1]+'"');
 });

 // no-reply 地址不再被自动排除 —— 交给可信验证判断(PLENTI_ADAPTATION §2)
 plAssertEq_(plExclude_('New customer referral','no-reply@plenti.example'),null,'no-reply address must not be excluded outright');
 plAssertEq_(plExclude_('New customer referral','noreply@plenti.example'),null,'noreply address must not be excluded outright');
 plAssertEq_(plExclude_('New customer referral','referrals@plenti.example'),null,'ordinary trusted sender is not excluded');

 // 内部域名判定在域名边界上做
 plAssertEq_(plExclude_('Hello','staff@notexample.org'),null,'internal check must not match a different domain');
 plAssertEq_(plExclude_('Hello','staff@sub.example.org'),null,'internal check does not widen to subdomains');

 console.log('PASS: 9 exclusion cases, 3 no-reply cases, 2 internal-domain boundary cases');
}

// ============================================================
// 4. 空发件人绝不判 internal(必须有人看到)
// ============================================================

function testPlentiEmptySenderNeverInternal(){
 plTestBaseline_();
 var direct=plExclude_('New customer referral','');
 plAssert_(direct,'empty sender must produce an exclusion result, not null');
 plAssertEq_(direct.kind,'review','empty sender must be review');
 plAssert_(direct.kind!=='internal','empty sender must never be classified internal');
 plAssertEq_(direct.leadCandidate,true,'empty sender must be flagged leadCandidate so a label is applied');
 plAssert_(/Sender could not be determined/.test(direct.reason),'empty sender reason');

 // 走完整流程:X-Original-Sender 头缺失的真实场景
 var state=plTestWithFakeApi_(function(calls){
  var s=plProcess_(plTestMessage_('original-sender-missing'),false);
  plAssertEq_(plTestPosts_(calls).length,0,'missing sender must not write anything to Salesforce');
  return s;
 });
 plAssertEq_(state.state,'review','missing X-Original-Sender must land in review');
 plAssertEq_(state.kind,'review','missing X-Original-Sender must not be kind internal');
 plAssertEq_(state.leadCandidate,true,'missing X-Original-Sender must be visible via the Review label');
 plAssert_(/Sender could not be determined/.test(state.reason),'missing sender reason surfaces to the reviewer');

 // 标签汇总确认它确实会亮 Review
 var flags=ivLeadLabelFlags_([state]);
 plAssertEq_(flags.review,true,'missing sender must raise the SF-Lead-Review label');
 plAssertEq_(flags.created,false,'no Lead was created');

 console.log('PASS: empty sender is reviewed and labelled, never silently dropped as internal');
}

// ============================================================
// 5. 不可信邮件只细化 reason,结论恒为 review
// ============================================================

function testPlentiUntrustedReason(){
 plTestBaseline_();
 plAssert_(/Employment enquiry/.test(plUntrustedReason_('EOI - Trade Assistant','Dear Recruitment Team, please find my cover letter attached')),'recruitment refinement');
 plAssert_(/offering products/.test(plUntrustedReason_('Partnership','Our company is offering investment opportunities for investors and developers.')),'promotion refinement');
 plAssert_(/Voice recording/.test(plUntrustedReason_('New voice message from 0400 000 000','')),'voicemail refinement');
 plAssertEq_(plUntrustedReason_('New customer referral','Referral reference: FIXTURE-0001'),'','no refinement for ordinary text');
 console.log('PASS: 4 untrusted-reason refinement cases');
}

// ============================================================
// 6. 解析骨架:字段正则留空时的行为
// ============================================================

function testPlentiParserSkeleton(){
 plTestBaseline_();
 var parsed=parsePlentiReferral_(plTestMessage_('trusted-referral'));
 plAssertEq_(parsed.kind,'unknown','no kind patterns are defined yet, so kind must be unknown');
 plAssertEq_(parsed.confidence,'low','unknown kind can never be high confidence');
 plAssertEq_(parsed.referralId,'','no referral-id pattern is defined yet');
 plAssertEq_(parsed.customer.email,'','no email pattern is defined yet');
 plAssertEq_(parsed.missing.length,PLENTI_REQUIRED_FIELDS.length,'every required field is missing while patterns are empty');
 plAssert_(/kind not recognised/.test(parsed.reason)&&/Missing required field/.test(parsed.reason),'reason explains both problems');

 // 客户身份绝不回退到发件人(规格 §5.2)
 plAssert_(parsed.customer.email!=='referrals@plenti.example','customer email must never fall back to the sender address');

 // 多候选检测:同一字段匹出两个不同值 → ambiguous → 无法 high
 var saved=PLENTI_PATTERNS.email;
 PLENTI_PATTERNS.email=[/Email:\s*(\S+)/i,/Contact:\s*(\S+)/i];
 var ambiguous=parsePlentiReferral_(plTestMessageFrom_({
  id:'inline-ambiguous',subject:'New customer referral',date:'2026-09-07T03:20:00.000Z',headers:{},
  body:'Email: one@example.net\nContact: two@example.net\n'}));
 PLENTI_PATTERNS.email=saved;
 plAssert_(ambiguous.ambiguous.indexOf('email')>=0,'two different values for one field must be flagged ambiguous');
 plAssertEq_(ambiguous.confidence,'low','ambiguous fields can never be high confidence');
 plAssert_(/Multiple candidate values/.test(ambiguous.reason),'ambiguity reason');

 console.log('PASS: 9 parser-skeleton cases including multi-candidate detection');
}

// ============================================================
// 7. 业务级去重未实现时必须卡死(fail-closed)
// ============================================================

function testPlentiReferralLookupFailClosed(){
 plTestBaseline_();
 plAssertThrows_(function(){plFindReferral_('FIXTURE-0001');},/not implemented/,'referral lookup stub must throw');

 plTestWithFakeApi_(function(calls){
  plAssertThrows_(function(){plResolve_(plTestMessage_('trusted-referral'),plTestParsed_());},
   /Refusing to create a Lead without business-level deduplication/,'plResolve_ must not fall through to creation');
  plAssertEq_(plTestPosts_(calls).length,0,'fail-closed path must not write anything');
 });

 // 缺 referral ID / 缺客户邮箱 → review,不进创建路径
 plTestWithFakeApi_(function(calls){
  var noId=plTestParsed_();noId.referralId='';
  plAssert_(/referral ID missing/.test(plResolve_(plTestMessage_('trusted-referral'),noId).review||''),'missing referral id must review');
  var noEmail=plTestParsed_();noEmail.customer.email='';
  plAssert_(/Customer email missing/.test(plResolve_(plTestMessage_('trusted-referral'),noEmail).review||''),'missing customer email must review');
  plAssertEq_(plTestPosts_(calls).length,0,'neither case may write');
 });
 console.log('PASS: 4 fail-closed deduplication cases');
}

// ============================================================
// 8. 去重的另外两层
// ============================================================

function testPlentiDeduplicationLayers(){
 plTestBaseline_();
 var message=plTestMessage_('trusted-referral'),parsed=plTestParsed_();
 var realFind=plFindReferral_;

 // D1 邮件级:Description 已带本邮件标记 → 返回已有 Lead,不重复创建
 plTestWithFakeApi_(function(calls){
  ivQuery_=function(q){calls.push({kind:'query',query:q});return [{Id:'00Qexisting00001AAA',Description:'[Intake: '+message.getId()+']',IsConverted:false,Status:'New'}];};
  var r=plResolve_(message,parsed);
  plAssert_(r.lead&&r.lead.Id==='00Qexisting00001AAA','existing marker must resolve to the existing Lead');
  plAssert_(!r.create,'must not request creation');
  plAssertEq_(plTestPosts_(calls).length,0,'re-running the same message must not create anything');
 });

 // D3 跨邮箱缓解:同客户邮箱已有活跃 Lead → review(规格 §5.5)
 plFindReferral_=function(){return null;};
 plTestWithFakeApi_(function(calls){
  ivQuery_=function(q){calls.push({kind:'query',query:q});return [{Id:'00Qother0000001AAA',Description:'from the info mailbox',IsConverted:false,Status:'New'}];};
  var r=plResolve_(message,parsed);
  plAssert_(/Existing active Lead/.test(r.review||''),'active Lead for the same customer must go to review');
  plAssertEq_(plTestPosts_(calls).length,0,'cross-mailbox collision must not create a second Lead');
 });

 // 已转换 / Unqualified 的旧 Lead 不算活跃,不挡新转介
 plTestWithFakeApi_(function(calls){
  ivQuery_=function(q){calls.push({kind:'query',query:q});return [{Id:'00Qold000000001AAA',Description:'',IsConverted:true,Status:'Closed'}];};
  plAssertEq_(plResolve_(message,parsed).create,true,'a converted Lead must not block a new referral');
 });
 plFindReferral_=realFind;
 console.log('PASS: 3 deduplication-layer cases');
}

// ============================================================
// 9. 创建前防重锁(规格 §2 第三样可继承的东西)
// ============================================================

function testPlentiCreateLock(){
 plTestBaseline_();
 var message=plTestMessage_('trusted-referral'),parsed=plTestParsed_(),p=PropertiesService.getScriptProperties();

 plTestWithFakeApi_(function(calls){
  var lead=plCreateLead_(message,parsed);
  plAssertEq_(lead.Id,'00Qfixture000001AAA','create returns the read-back Lead');
  var posts=plTestPosts_(calls);
  plAssertEq_(posts.length,1,'exactly one POST');
  plAssertEq_(posts[0].path,'sobjects/Lead','POST target');
  var lock=JSON.parse(p.getProperty('IV2_CREATE_'+message.getId()));
  plAssertEq_(lock.state,'created','lock advances to created after a successful POST');
  plAssertEq_(lock.id,'00Qfixture000001AAA','lock records the new record id');
 });

 // 锁已存在 → 抛错要求人工核查,绝不重试创建
 plTestWithFakeApi_(function(calls){
  plAssertThrows_(function(){plCreateLead_(message,parsed);},/Earlier create outcome is uncertain/,'existing lock must block a retry');
  plAssertEq_(plTestPosts_(calls).length,0,'blocked retry must not POST');
 });

 // 写入顺序:requested 必须先于 POST 落盘,否则超时后无从判断
 plTestClearState_();
 plTestWithFakeApi_(function(calls){
  ivReq_=function(path,method,data){
   calls.push({kind:'req',path:path,method:method||'get',data:data});
   var atPost=JSON.parse(p.getProperty('IV2_CREATE_'+message.getId())||'{}');
   plAssertEq_(atPost.state,'requested','the lock must already read "requested" while the POST is in flight');
   return {id:'00Qfixture000001AAA'};
  };
  plCreateLead_(message,parsed);
 });
 console.log('PASS: 4 create-lock cases');
}

// ============================================================
// 10. Lead 字段映射(规格 §5.9 / §5.2 / §5.6)
// ============================================================

function testPlentiLeadPayload(){
 plTestBaseline_();
 var message=plTestMessage_('trusted-referral'),parsed=plTestParsed_(),payload=plLeadPayload_(message,parsed);

 plAssertEq_(payload.Email,'dale.example@example.net','Lead.Email must be the customer address');
 plAssert_(payload.Email!=='referrals@plenti.example','Lead.Email must never be the Plenti sender address');
 plAssertEq_(payload.LeadSource,'Plenti','LeadSource per spec 5.9 (picklist value pending Q3)');
 plAssertEq_(payload.Contact_Attempt_Count__c,0,'Contact_Attempt_Count__c starts at zero');
 plAssertEq_(payload.OwnerId,'005000000000000AAA','OwnerId comes from INTAKE_ADMIN_ID');
 plAssertEq_(payload.Status,'New','Status');
 plAssertEq_(payload.Plenti_Received_At__c,message.getDate().toISOString(),'Plenti_Received_At__c must equal the message date, not the creation time');
 plAssert_(!('Lead_Category__c' in payload),'Lead_Category__c is deliberately not written (D-011)');
 plAssertEq_(payload.StateCode,'SA','state code is upper-cased');
 plAssertEq_(payload.CountryCode,'AU','country code accompanies an Australian address');
 plAssert_(payload.Description.indexOf('[Intake: '+message.getId()+']')===0,'Description starts with the message marker');
 plAssert_(payload.Description.indexOf('FIXTURE-0001')>=0,'Description records the referral id');
 plAssert_(payload.Description.indexOf('12 Fictional Street')<0,'the raw email body is not copied into Description (D-012)');
 plAssert_(payload.Description.length<=32000,'Description stays within the Salesforce limit');

 // D-012 最小集合:Description 的每一行都必须命中白名单。Phase 3 填字段
 // 正则时若把 application ID / broker ID / 客户编号顺手塞进摘要,这里会变红。
 var allowed=[/^\[Intake: /,/^PLENTI REFERRAL - PENDING ADMIN REVIEW$/,/^Source: /,/^Plenti referral ID: /,/^Subject: /,/^Raw email body is intentionally not copied/];
 payload.Description.split('\n').forEach(function(line){
  if(!line.trim())return;
  plAssert_(allowed.some(function(re){return re.test(line);}),'Description carries a line outside the D-012 minimum set: '+line);
 });
 console.log('PASS: 15 Lead field-mapping cases including the Description minimum set');
}

// ============================================================
// 11. .eml 留存默认关闭(规格 §5.6)
// ============================================================

function testPlentiRawEmailDefaultOff(){
 plTestBaseline_();
 var message=plTestMessage_('trusted-referral');
 plAssertEq_(ivAttachRawEmail_(),false,'ATTACH_RAW_EMAIL defaults to false when unset');
 plTestWithFakeApi_(function(calls){
  // getRawContent 在 mock 里会抛错;返回 false 且零调用才说明开关真的挡在最前面
  plAssertEq_(ivAttachSource_(message,{id:'00Qfixture000001AAA'}),false,'attachment is skipped while the switch is off');
  plAssertEq_(calls.length,0,'the switch must short-circuit before any query or upload');
 });
 plTestSetProps_({ATTACH_RAW_EMAIL:'false'});
 plAssertEq_(ivAttachRawEmail_(),false,'explicit "false" stays off');
 plTestSetProps_({ATTACH_RAW_EMAIL:'true'});
 plAssertEq_(ivAttachRawEmail_(),true,'only the exact string "true" turns it on');
 plTestSetProps_({ATTACH_RAW_EMAIL:null});
 console.log('PASS: 4 raw-email retention switch cases');
}

// ============================================================
// 12. 缺配置即抛错停止(规格 §3 禁止事项 #2)
// ============================================================

function testPlentiRequiredProperties(){
 plTestBaseline_();
 plTestSetProps_({PLENTI_TRUSTED_SENDERS:null});
 plAssertThrows_(function(){isPlentiSource_(plTestMessage_('trusted-referral'));},/PLENTI_TRUSTED_SENDERS/,'missing trusted-sender list must stop processing');
 plTestSetProps_({PLENTI_TRUSTED_SENDERS:'   ,  '});
 plAssertThrows_(function(){plTrustedSenders_();},/PLENTI_TRUSTED_SENDERS/,'a list of only separators counts as missing');

 plTestBaseline_();
 plTestSetProps_({INTERNAL_DOMAIN:null});
 plAssertThrows_(function(){plExclude_('Hello','someone@other.example');},/INTERNAL_DOMAIN/,'missing internal domain must stop processing');

 plTestBaseline_();
 plTestSetProps_({EDOCS_GROUP_ADDRESS:null});
 plAssertThrows_(function(){ivGroupAddress_();},/EDOCS_GROUP_ADDRESS/,'missing group address must stop processing');

 plTestBaseline_();
 plTestSetProps_({INTAKE_ADMIN_ID:'not-a-user-id'});
 plAssertThrows_(function(){plLeadPayload_(plTestMessage_('trusted-referral'),plTestParsed_());},/INTAKE_ADMIN_ID/,'invalid admin id must stop processing');

 plTestBaseline_();
 console.log('PASS: 5 missing-configuration cases');
}

// ============================================================
// 13. 端到端分流:没有任何一条路径会在骨架期写 Salesforce
// ============================================================

function testPlentiProcessFlow(){
 plTestBaseline_();
 var cases=[
  ['trusted-referral','review',true,/could not be parsed with confidence/],
  ['trusted-noreply','review',true,/could not be parsed with confidence/],
  ['trusted-with-promo-footer','review',true,/could not be parsed with confidence/],
  ['spoofed-plenti','review',true,/not a verified Plenti sender/],
  ['unlisted-sender-dmarc-pass','review',true,/not a verified Plenti sender/],
  ['auth-header-missing','review',true,/not a verified Plenti sender/],
  ['lookalike-domain','review',true,/not a verified Plenti sender/],
  ['suffix-domain','review',true,/not a verified Plenti sender/],
  ['subdomain-sender','review',true,/not a verified Plenti sender/],
  ['header-from-mismatch','review',true,/not a verified Plenti sender/],
  ['original-sender-missing','review',true,/Sender could not be determined/]
 ];
 plTestWithFakeApi_(function(calls){
  cases.forEach(function(c){
   plTestClearState_();
   var s=plProcess_(plTestMessage_(c[0]),false);
   plAssertEq_(s.state,c[1],c[0]+' state');
   plAssertEq_(s.leadCandidate,c[2],c[0]+' leadCandidate');
   plAssert_(c[3].test(s.reason),c[0]+' reason should match '+c[3]+', got: '+s.reason);
  });
  plAssertEq_(plTestPosts_(calls).length,0,'the parser skeleton must never create a Lead');
 });

 // 可信邮件的页脚营销话术不得把它变成 promotion(D-010 的漏单路径)
 plTestClearState_();
 plTestWithFakeApi_(function(){
  var s=plProcess_(plTestMessage_('trusted-with-promo-footer'),false);
  plAssert_(s.kind!=='promotion','a trusted referral must never be classified as promotion');
  plAssert_(!/offering products/.test(s.reason),'the promotion refinement must not apply to trusted mail');
 });

 // 幂等:第二次跑直接返回既有状态,不重复处理
 plTestClearState_();
 plTestWithFakeApi_(function(calls){
  var first=plProcess_(plTestMessage_('trusted-referral'),false);
  var before=calls.length;
  var second=plProcess_(plTestMessage_('trusted-referral'),false);
  plAssertEq_(second.reason,first.reason,'second run returns the stored state');
  plAssertEq_(calls.length,before,'second run performs no further calls');
 });

 // 异常一律落 error 并保持可见,不吞掉
 plTestClearState_();
 plTestSetProps_({INTERNAL_DOMAIN:null});
 plTestWithFakeApi_(function(){
  var s=plProcess_(plTestMessage_('trusted-referral'),false);
  plAssertEq_(s.state,'error','a configuration failure lands in error state');
  plAssertEq_(s.leadCandidate,true,'errors stay visible through the Review label');
  plAssertEq_(ivLeadLabelFlags_([s]).review,true,'error state raises the Review label');
 });
 plTestBaseline_();

 console.log('PASS: 11 end-to-end routing cases, promotion guard, idempotency, error visibility');
}

// ============================================================
// 14. review 解除桩不改动任何状态
// ============================================================

function testPlentiRefreshReviewStub(){
 plTestBaseline_();
 var message=plTestMessage_('trusted-referral');
 plTestWithFakeApi_(function(calls){
  plProcess_(message,false);
  var before=JSON.stringify(ivGet_(message.getId()));
  plRefreshReview_(message);
  plAssertEq_(JSON.stringify(ivGet_(message.getId())),before,'the Phase 2 stub must not change any state');
  plAssertEq_(plTestPosts_(calls).length,0,'the stub must not write to Salesforce');
 });
 console.log('PASS: review-refresh stub is a genuine no-op');
}

// ============================================================
// 入口
// ============================================================

function runPlentiRegressionTests(){
 testPlentiSourceTrust();
 testPlentiTrustedSenderBoundary();
 testPlentiExclusions();
 testPlentiEmptySenderNeverInternal();
 testPlentiUntrustedReason();
 testPlentiParserSkeleton();
 testPlentiReferralLookupFailClosed();
 testPlentiDeduplicationLayers();
 testPlentiCreateLock();
 testPlentiLeadPayload();
 testPlentiRawEmailDefaultOff();
 testPlentiRequiredProperties();
 testPlentiProcessFlow();
 testPlentiRefreshReviewStub();
}
