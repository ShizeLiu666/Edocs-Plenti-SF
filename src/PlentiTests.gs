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

/** 合成页面 fixture 的 HTML。 */
function plTestBrowserHtml_(){return plFixtures_()['browser-view-sample'].html;}
function plTestBrowserToken_(){return plFixtures_()['browser-view-sample'].token;}

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
 plAssertEq_(payload.LeadSource,'Plenti','LeadSource per spec 5.9 (picklist value pending Q3)');
 plAssertEq_(payload.Contact_Attempt_Count__c,0,'Contact_Attempt_Count__c starts at zero');
 plAssertEq_(payload.OwnerId,'005000000000000AAA','OwnerId comes from INTAKE_ADMIN_ID');
 plAssertEq_(payload.Status,'New','Status');
 plAssertEq_(payload.Plenti_Received_At__c,message.getDate().toISOString(),'Plenti_Received_At__c must equal the message date, not the creation time');
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
 plAssert_(payload.Description.length<=32000,'Description stays within the standard-field limit');
 plAssert_(payload.Description.indexOf('12 Fictional Street')<0,'the email body is not copied into Description (D-012)');

 // 降级时 Description 要显眼地标出来
 var degraded=plLeadPayload_(message,parsed,{html:'',meta:{found:[],degraded:true}});
 plAssert_(/BROWSER VIEW UNAVAILABLE/.test(degraded.Description),'a degraded Lead says so in Description so a human knows to open the link');
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
 var cases=[
  ['trusted-referral','review',true,/Not identifiable as a Plenti referral/],
  ['trusted-noreply','review',true,/Not identifiable as a Plenti referral/],
  ['trusted-with-promo-footer','review',true,/Not identifiable as a Plenti referral/],
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
 plAssertEq_(posted.LeadSource,'Plenti','the real field mapping is still exercised — that is the point of the switch');
 plAssertEq_(posted.Plenti_Received_At__c,message.getDate().toISOString(),'the received timestamp is still the real message date');

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
 plAssertEq_(fields.found.length,3,'all three labelled fields are found');
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
  '<p><strong>Customer address</strong></p><p></p>'+
  '<p><strong>Renewable systems</strong></p><p>[]</p>');
 plAssertEq_(emptyOnly.name,'','an empty block yields no name');
 plAssertEq_(emptyOnly.systems,'','[] is not a value');
 plAssertEq_(emptyOnly.missing.length,3,'all three are reported missing');

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
   var posts=plTestPosts_(calls);
   plAssertEq_(posts.length,1,'still exactly one Lead');
   plAssertEq_(posts[0].data.Plenti_Lead_ID__c,token,'identity is preserved even when the page could not be read');
   plAssert_(/BROWSER VIEW UNAVAILABLE/.test(posts[0].data.Description),'Description tells the reviewer to open the link');
   plAssertEq_(posts[0].data.Plenti_Browser_View_HTML__c,'','no page stored');
  });
 });

 plTestClearState_();
 plTestBaseline_();
 console.log('PASS: 48 browser-view cases (link extraction, page parsing, degradation, end-to-end)');
}

// ============================================================
// 入口
// ============================================================

function runPlentiRegressionTests(){
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
 testPlentiRefreshReviewStub();
}
