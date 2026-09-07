/**
 * Shareable snapshot of the info-mailbox intake, 2026-09-07.
 * NOT a Plenti parser. Disabled until adapted and validated.
 * Export-only safety changes are documented in README_CN.md.
 */
function getSalesforceClientCredentialsToken_() {
  var p = PropertiesService.getScriptProperties();
  var base = p.getProperty('SF_LOGIN_URL');
  if (!base) throw new Error('Configure SF_LOGIN_URL first');
  var response = UrlFetchApp.fetch(base + '/services/oauth2/token', {
    method: 'post', payload: {grant_type: 'client_credentials', client_id: p.getProperty('SF_CLIENT_ID'), client_secret: p.getProperty('SF_CLIENT_SECRET')}, muteHttpExceptions: true
  });
  var status = response.getResponseCode(), body = JSON.parse(response.getContentText() || '{}');
  if (status !== 200 || !body.access_token || !body.instance_url) throw new Error('Salesforce token request failed (' + status + '): ' + (body.error_description || body.error || 'Unknown error'));
  return body;
}
function testSalesforceClientCredentials() {
  var token = getSalesforceClientCredentialsToken_();
  var response = UrlFetchApp.fetch(token.instance_url + '/services/data/', {method:'get', headers:{Authorization:'Bearer ' + token.access_token}, muteHttpExceptions:true});
  console.log('Salesforce read-only API connection status: ' + response.getResponseCode());
  return response.getResponseCode();
}
function extractSender_(message) {
  var from=String(message.getFrom()||'');
  var match=from.match(/<([^>]+)>/)||from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  var email=match?(match[1]||match[0]).trim().toLowerCase():'';
  var name=from.replace(/<[^>]+>/,'').replace(/["']/g,'').trim();
  return {email:email,name:name||(email?email.split('@')[0]:'Email Enquiry')};
}
var INTAKE_V2={version:'2026-09-07-share',labels:['SF-Lead-Created','SF-Lead-Review','SF-Lead-Updated']};
function ivAdmin_(){var id=PropertiesService.getScriptProperties().getProperty('INTAKE_ADMIN_ID');if(!/^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id||''))throw new Error('Configure valid INTAKE_ADMIN_ID');return id;}
function ivSource_(){var email=PropertiesService.getScriptProperties().getProperty('INTAKE_MAILBOX');if(!email)throw new Error('Configure INTAKE_MAILBOX');return email;}
function ivRecordUrl_(type,id){return ivReq_.token.instance_url+'/lightning/r/'+type+'/'+id+'/view';}
function ivReq_(path,method,data){
 if(!ivReq_.token)ivReq_.token=getSalesforceClientCredentialsToken_();
 var t=ivReq_.token,opt={method:method||'get',headers:{Authorization:'Bearer '+t.access_token},muteHttpExceptions:true};
 if(data!==undefined){opt.contentType='application/json';opt.payload=JSON.stringify(data);}
 var r=UrlFetchApp.fetch(t.instance_url+'/services/data/v67.0/'+path,opt),body=r.getContentText();
 if(r.getResponseCode()>=300)throw new Error('SF '+r.getResponseCode()+' '+body.slice(0,1800));
 return body?JSON.parse(body):{};
}
function ivQuote_(s){return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");}
function ivQuery_(q){var d=ivReq_('query?q='+encodeURIComponent(q));if(!d.done)throw new Error('Ambiguous result exceeds query page');return d.records;}
function ivKey_(id){return 'IV2_MSG_'+id;}
function ivGet_(id){var s=PropertiesService.getScriptProperties().getProperty(ivKey_(id));return s?JSON.parse(s):null;}
function ivSave_(id,s){s.at=new Date().toISOString();PropertiesService.getScriptProperties().setProperty(ivKey_(id),JSON.stringify(s));}
function ivLabel_(th,name,add){var l=GmailApp.getUserLabelByName(name);if(!l&&add)l=GmailApp.createLabel(name);if(l){if(add)th.addLabel(l);else th.removeLabel(l);}}
function ivTop_(text){return String(text||'').replace(/\r/g,'').split(/\n\s*(?:From:|On .{0,200}wrote:|Begin forwarded message:|[-_]{5,}|>)/i)[0].trim();}
function ivClassify_(subject,plain,from){
 var top=ivTop_(plain),text=top.replace(/\s+/g,' ').toLowerCase(),sub=String(subject||'').toLowerCase();
 if(!from||/@sunterra\.com\.au$/i.test(from))return {kind:'internal',top:top};
 if(/(?:^|\.)(?:salesforce\.com|sfcustomeremail\.com)$/i.test(String(from).split('@').pop())&&/(?:a lead has been assigned|please follow up your unconverted lead)/i.test(sub))return {kind:'ignore',reason:'Salesforce automatic lead notification',top:top};
 if(/(?:salesforce could not create this lead)/i.test(sub))return {kind:'review',reason:'Web-to-Lead failure requires administrator review',top:top};
 if(/(?:\b(?:recruitment|hiring) (?:team|manager)\b|\b(?:job application|applying for|trade assistant|cover letter|resume attached)\b)/i.test(sub+' '+text))return {kind:'review',reason:'Employment enquiry - not a sales Lead',top:top};
 if(/\btest\d*\b/i.test(sub))return {kind:'review',reason:'Possible test email',top:top};
 var pitch=/\b(?:we|our company|[a-z ]+ energia)\s+(?:are |is )?(?:offering|offer|provide|supply|selling)\b/.test(text)||/(?:opportunities (?:are )?(?:offered|for)|for (?:investors|developers)|land .*option agreements|we can (?:help|improve|boost)|seo services|marketing services|guest post)/.test(text);
 if(pitch)return {kind:'promotion',reason:'Sender offering products, investment or services to Sunterra',top:top};
 if(/(?:mailer-daemon|postmaster|no-?reply)/i.test(from)||/(?:delivery status notification|out of office|automatic reply)/.test(sub))return {kind:'ignore',reason:'Automatic message',top:top};
 if(/(?:new voice message|voicemail)/.test(sub))return {kind:'review',reason:'Voice recording needs review',top:top};
 var clean=text.replace(/\bno\s+(?:issues?|problems?|faults?)(?:\s+with)?/g,' ').replace(/(?:website|button|form)[^.]{0,70}(?:not work|didn.t work|failed)/g,' ');
 var purchase=/(?:\b(?:i|we)(?:'m| am| are|'re)?\s+(?:enquir\w*|inquir\w*|looking|interested|want|need|would like)|\b(?:can|could) you\b.{0,70}(?:quote|install|supply|upgrade)|\b(?:please|request|requesting)\b.{0,35}(?:quote|quotation)|\bupgrade (?:my|our|the existing)|\bincrease battery capacity)/.test(text);
 purchase=purchase||/(?:^|\n)\s*(?:looking\s+for|seeking|after|need|want)\s+(?:(?:a|some)\s+)?(?:quotes?|quotations?|pricing|prices?)\b/i.test(top);
 purchase=purchase||/\b(?:can|could|would) you\b.{0,60}\b(?:cost|price|pricing|options|quotation)\b/.test(text)||/\b(?:want|interested|considering|looking|options)\b.{0,90}\b(?:add(?:ing)?|upgrad(?:e|ing)|expand(?:ing)?|install(?:ing)?)\b.{0,45}\b(?:battery|batteries|solar|panels|storage)\b/.test(text);
 var product=/\b(?:solar|battery|batteries|inverter|ev charger|charging|off.grid|panels)\b/.test(text+' '+sub);
 var fault=/(?:\b(?:inverter|battery|system|solar)\b.{0,45}(?:not working|failed|fault|offline|broken)|\b(?:repair|warranty claim|complaint|roof leak)\b)/.test(clean);
 if(purchase&&product&&fault)return {kind:'review',reason:'Both new purchase and service issue',top:top};
 if(purchase&&product)return {kind:'sales',reason:'Customer requests purchase, installation or upgrade',top:top};
 if(fault)return {kind:'service',reason:'Fault, repair or complaint',top:top};
 if(/^\s*(?:re|aw):/i.test(subject||''))return {kind:'reply',reason:'Reply requiring record association',top:top};
 if(/(?:newsletter|unsubscribe|invoice|statement|purchase order)/i.test(sub+' '+text)&&!purchase)return {kind:'ignore',reason:'Non-sales administrative or newsletter mail',top:top};
 if(product&&/\b(?:quote|quotation|pricing|cost options|battery add.on|battery upgrade)\b/.test(sub+' '+text)&&!/(?:invoice|payment|warranty|repair|installation date|installation schedule|reschedule)/.test(text))return {kind:'review',leadCandidate:true,reason:'Possible sales enquiry requires review',top:top};
 return {kind:'review',reason:'Insufficient evidence to classify',top:top};
}
function ivContactMatch_(email){
 var verified=PropertiesService.getScriptProperties().getProperty('IV2_VERIFIED_ACCOUNT_'+email);
 if(verified){var va=ivQuery_("SELECT Id,Name,PersonContactId,Customer_Reference_Number__c FROM Account WHERE Id='"+verified+"'")[0];if(va)return {account:va,contacts:[],ambiguous:false};}
 var e=ivQuote_(email),accounts=ivQuery_("SELECT Id,Name,PersonContactId,Customer_Reference_Number__c FROM Account WHERE PersonEmail='"+e+"' OR Account_Email__c='"+e+"'"),contacts=ivQuery_("SELECT Id,Name,AccountId FROM Contact WHERE Email='"+e+"'");
 var ids={};accounts.forEach(function(a){ids[a.Id]=true});contacts.forEach(function(c){if(c.AccountId)ids[c.AccountId]=true});
 var all=Object.keys(ids);if(all.length!==1)return {account:null,ambiguous:all.length>1};
 var a=accounts.filter(function(x){return x.Id===all[0]})[0]||ivQuery_("SELECT Id,Name,PersonContactId,Customer_Reference_Number__c FROM Account WHERE Id='"+all[0]+"'")[0];
 return {account:a,contacts:contacts.filter(function(c){return c.AccountId===a.Id}),ambiguous:false};
}
function ivLeadFields_(){return 'Id,Name,Email,Phone,MobilePhone,Street,City,State,StateCode,PostalCode,Country,CountryCode,OwnerId,Status,IsConverted,ConvertedOpportunityId,ConvertedContactId,ConvertedAccountId,Lead_Category__c,Description';}
function ivResolve_(message,sender,classification){
 var e=ivQuote_(sender.email),leads=ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Email='"+e+"'"),open=leads.filter(function(l){return !l.IsConverted&&l.Status!=='Unqualified'});
 var source=leads.filter(function(l){return String(l.Description||'').indexOf('[Intake: '+message.getId()+']')>=0});if(source.length===1)return {lead:source[0],created:true};
 var parent=message.getHeader('In-Reply-To')||'',refs=message.getHeader('References')||'';
 var ids=(refs+' '+parent).match(/<[^>]+>/g)||[];
 for(var i=ids.length-1;i>=0;i--){var k='IV2_REF_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,ids[i])).slice(0,40);var rid=PropertiesService.getScriptProperties().getProperty(k);var linked=leads.filter(function(l){return l.Id===rid});if(linked.length===1&&classification.kind==='reply')return {lead:linked[0]};}
 if(classification.kind==='reply'){
  if(open.length===1)return {lead:open[0]};
  if(open.length>1)return {review:'Multiple active Leads for sender'};
  var converted=leads.filter(function(l){return l.IsConverted&&l.ConvertedOpportunityId});if(converted.length===1)return {lead:converted[0]};
  var match=ivContactMatch_(sender.email);
  if(match.account){var opps=ivQuery_("SELECT Id,Name,OwnerId,AccountId FROM Opportunity WHERE AccountId='"+match.account.Id+"' AND IsClosed=false");if(opps.length===1)return {opportunity:opps[0],contact:match.contacts.length===1?match.contacts[0].Id:match.account.PersonContactId};}
  return {review:'Reply has no unique active record match'};
 }
 if(open.length)return {review:'Existing active enquiry: confirm same request versus a new project'};
 var match=ivContactMatch_(sender.email);if(match.ambiguous)return {review:'Multiple matching customer Accounts'};
 return {account:match.account};
}
function ivExtract_(top){
 var text=top.replace(/\r/g,''),flat=text.replace(/[^\S\n]+/g,' '),p=flat.match(/(?:\+61|0)[2-478](?:[ -]?\d){8}\b/),fields={};
 if(p)fields.Phone=p[0].replace(/[ -]/g,'');
 var a=flat.match(/(?:\baddress\s*(?:is|:)\s*)?(\d+[a-z]?(?:\/\d+)?\s+[a-z][a-z '\-]{0,65}?\s(?:street|st|road|rd|crescent|cres|avenue|ave|drive|dr|way|court|ct|terrace|tce|lane|ln))\s*,?\s+([a-z][a-z '\-]{1,45}?)(?=\.|,|\s+(?:nsw|wa|sa|vic|qld|tas|act|nt)\b|\n|$)/i);
 if(a){fields.Street=a[1].trim();fields.City=a[2].trim();var tail=flat.slice(a.index+a[0].length);var s=tail.match(/^\s*,?\s*(NSW|WA|SA|VIC|QLD|TAS|ACT|NT)\b\s*(\d{4})?/i);if(s){fields.StateCode=s[1].toUpperCase();fields.CountryCode='AU';if(s[2])fields.PostalCode=s[2];}}
 return fields;
}
function ivCreateCandidate_(m,sender,c,match){
 var id=m.getId(),marker='[Intake: '+id+']',p=PropertiesService.getScriptProperties();
 var existing=ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Email='"+ivQuote_(sender.email)+"'").filter(function(l){return String(l.Description||'').indexOf(marker)>=0;});
 if(existing.length===1)return existing[0];if(existing.length>1)throw new Error('Multiple source-matched Leads require review');
 if(p.getProperty('IV2_CREATE_'+id))throw new Error('Earlier create outcome is uncertain; check Salesforce before retrying creation');
 var accountText=match.account?'Existing customer: '+match.account.Name+' | '+match.account.Customer_Reference_Number__c+'\nAccount: '+ivRecordUrl_('Account',match.account.Id)+'\nConversion: select this EXISTING Account; do not create another Account.\n':'';
 var payload={LastName:sender.name.slice(0,80),Email:sender.email,Company:'Individual / Residential',Status:'New',OwnerId:ivAdmin_(),LeadSource:'Other',Lead_Category__c:'Other',Contact_Attempt_Count__c:0,Description:(marker+'\nEMAIL SALES ENQUIRY - PENDING ADMIN REVIEW\nSource: '+ivSource_()+'\nSubject: '+m.getSubject()+'\n'+accountText+'\n'+c.top).slice(0,32000)};
 var extracted=ivExtract_(c.top);Object.keys(extracted).forEach(function(k){payload[k]=extracted[k]});
 p.setProperty('IV2_CREATE_'+id,JSON.stringify({state:'requested',at:new Date().toISOString()}));
 var result=ivReq_('sobjects/Lead','post',payload);
 p.setProperty('IV2_CREATE_'+id,JSON.stringify({state:'created',id:result.id,at:new Date().toISOString()}));
 if(match.account){p.setProperty('IV2_ACCOUNT_'+result.id,match.account.Id);var sub='Repeat business enquiry '+result.id;if(!ivQuery_("SELECT Id FROM Task WHERE Subject='"+sub+"'").length)ivReq_('sobjects/Task','post',{WhatId:match.account.Id,OwnerId:ivAdmin_(),Status:'Completed',Subject:sub,Description:'Confirmed/matched existing customer enquiry received from '+sender.email+'.\nLead: '+ivRecordUrl_('Lead',result.id)+'\nReuse this Account on Lead conversion. Original customer and jobs retained.'});}
 return ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Id='"+result.id+"'")[0];
}
function ivTarget_(resolved){
 if(resolved.opportunity)return {id:resolved.opportunity.Id,what:resolved.opportunity.Id,who:resolved.contact,owner:resolved.opportunity.OwnerId};
 var l=resolved.lead;if(l.IsConverted){if(!l.ConvertedOpportunityId)throw new Error('Converted Lead has no Opportunity to receive reply');var o=ivQuery_("SELECT Id,OwnerId FROM Opportunity WHERE Id='"+l.ConvertedOpportunityId+"'")[0];return {id:o.Id,what:o.Id,who:l.ConvertedContactId,owner:o.OwnerId};}
 return {id:l.Id,who:l.Id,owner:l.OwnerId,lead:l};
}
function ivAttachSource_(message,target){
 var title='Info email '+message.getId(),links=ivQuery_("SELECT ContentDocumentId,ContentDocument.Title FROM ContentDocumentLink WHERE LinkedEntityId='"+target.id+"'");
 if(!links.some(function(x){return x.ContentDocument.Title===title})){
 var raw=message.getRawContent();if(raw.length>12000000)throw new Error('Source email over 12 MB; manual attachment handling required');
 ivReq_('sobjects/ContentVersion','post',{Title:title,PathOnClient:title+'.eml',VersionData:Utilities.base64Encode(raw,Utilities.Charset.UTF_8),FirstPublishLocationId:target.id});
 }
}
function ivSupplementDescription_(existing,m,body){
 var current=String(existing||''),marker='[Gmail:'+m.getId()+']';
 if(current.indexOf(marker)>=0||current.indexOf('[Intake: '+m.getId()+']')>=0)return current;
 var block=marker+' Received '+m.getDate().toISOString()+'\nFrom: '+m.getFrom()+'\nSubject: '+m.getSubject()+'\n'+String(body||'').trim();
 var result=current+(current?'\n\n':'')+block;
 if(result.length>32000)throw new Error('Lead Description capacity exceeded; original email retained, manual review required');
 return result;
}
function ivRecordReply_(m,c,target){
 ivAttachSource_(m,target);
 var conflict=[];
 if(target.lead){
 var extracted=ivExtract_(c.top),patch={};
 Object.keys(extracted).forEach(function(k){if(!target.lead[k])patch[k]=extracted[k];else if(String(target.lead[k]).replace(/[^a-z0-9]/gi,'').toLowerCase()!==String(extracted[k]).replace(/[^a-z0-9]/gi,'').toLowerCase())conflict.push(k);});
 if(conflict.indexOf('CountryCode')>=0||conflict.indexOf('StateCode')>=0){['Street','City','StateCode','CountryCode','PostalCode'].forEach(function(k){delete patch[k]});}
 var description=ivSupplementDescription_(target.lead.Description,m,c.top);
 if(description!==String(target.lead.Description||''))patch.Description=description;
 if(Object.keys(patch).length)ivReq_('sobjects/Lead/'+target.id,'patch',patch);
 var check=ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Id='"+ivQuote_(target.id)+"'");if(check.length!==1)throw new Error('Lead read-back failed');
 target.verifiedFields=Object.keys(extracted).filter(function(k){return conflict.indexOf(k)<0&&String(check[0][k]||'').replace(/[^a-z0-9]/gi,'').toLowerCase()===String(extracted[k]).replace(/[^a-z0-9]/gi,'').toLowerCase();});
 if(String(check[0].Description||'')!==description)throw new Error('Lead Description verification failed');target.verifiedFields.push('Description');
 if(Object.keys(patch).some(function(k){return target.verifiedFields.indexOf(k)<0;}))throw new Error('Lead field update verification failed');
 }
 var ref=m.getHeader('Message-ID');if(ref&&target.lead){var key='IV2_REF_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,ref)).slice(0,40);PropertiesService.getScriptProperties().setProperty(key,target.lead.Id);}
 return conflict;
}
function ivProcess_(message,force){
 var id=message.getId(),prior=ivGet_(id);if(prior&&!force&&prior.state!=='error')return prior;
 var sender=extractSender_(message),c=ivClassify_(message.getSubject(),message.getPlainBody(),sender.email),state={state:'done',kind:c.kind,leadCandidate:!!c.leadCandidate,reason:c.reason||'',date:message.getDate().toISOString()},th=message.getThread();
 try{
 if(['internal','ignore','promotion'].indexOf(c.kind)>=0){ivSave_(id,state);return state;}
 if(c.kind==='service'||c.kind==='review'){state.state='review';ivSave_(id,state);return state;}
 var resolved=ivResolve_(message,sender,c);
 if(resolved.review){state.state='review';state.reason=resolved.review;ivSave_(id,state);return state;}
 if(!resolved.lead&&!resolved.opportunity){resolved.lead=ivCreateCandidate_(message,sender,c,resolved);resolved.created=true;}
 var target=ivTarget_(resolved);state.record=target.id;state.created=!!resolved.created;
 ivSave_(id,{state:'error',record:target.id,created:state.created,reason:'Processing in progress',date:state.date});
 var conflicts=ivRecordReply_(message,c,target);state.conflicts=conflicts;state.verifiedFields=target.verifiedFields||[];
 if(resolved.created||(target.lead&&target.lead.Lead_Category__c==='Other')||conflicts.length){state.state='review';state.reason=conflicts.length?'Conflicting fields: '+conflicts.join(', '):'New Lead awaiting administrator approval';}
 ivSave_(id,state);return state;
 }catch(e){state.state='error';state.reason=String(e.message||e).slice(0,1800);ivSave_(id,state);console.log('Intake error '+id+': '+state.reason);return state;}
}
function ivLeadLabelFlags_(states){
 var lead=states.filter(function(x){return x&&((x.record&&/^00Q/.test(x.record))||(!x.record&&(x.kind==='sales'||x.kind==='reply'||x.leadCandidate===true)));});
 var review=lead.some(function(x){return x.state==='review'||x.state==='error';});
 return {created:lead.some(function(x){return !!(x.created&&x.record);}),review:review,updated:!review&&lead.some(function(x){return !x.created&&x.record&&x.state==='done'&&x.verifiedFields&&x.verifiedFields.length>0;})};
}
function ivSyncLabels_(thread){
 var flags=ivLeadLabelFlags_(thread.getMessages().map(function(m){return ivGet_(m.getId());}));
 ivLabel_(thread,'SF-Lead-Created',flags.created);ivLabel_(thread,'SF-Lead-Review',flags.review);ivLabel_(thread,'SF-Lead-Updated',flags.updated);
}
function runIntakeV2(){
 var p=PropertiesService.getScriptProperties();if(p.getProperty('INTAKE_V2_ENABLED')!=='true'){console.log('Intake v2 held pending validation.');return;}
 if(p.getProperty('EDOCS_ADAPTATION_VALIDATED')!=='true')throw new Error('Plenti adaptation has not been validated. Read handoff instructions.');
 var lock=LockService.getScriptLock();if(!lock.tryLock(1000)){console.log('Another intake execution is running.');return;}
 try{
 var began=Date.now(),cut=new Date(p.getProperty('INTAKE_V2_START')),cursor=new Date(p.getProperty('INTAKE_V2_WATERMARK')||cut.toISOString());
 if(isNaN(cut.getTime())||isNaN(cursor.getTime()))throw new Error('Missing valid intake start/watermark');
 ivRefreshOutstanding_(began+30000);
 var lower=Math.max(cut.getTime(),cursor.getTime()-172800000),before=Math.floor(began/1000)+1,query='after:'+Math.floor(lower/1000)+' before:'+before+' -in:spam -in:trash',offset=0,count=0,done=false;
 while(Date.now()-began<220000){
 var threads=GmailApp.search(query,offset,50);if(!threads.length){done=true;break;}
 for(var i=0;i<threads.length;i++){
 var msgs=threads[i].getMessages();for(var j=0;j<msgs.length;j++){if(msgs[j].getDate().getTime()<cut.getTime())continue;ivRefreshReview_(msgs[j]);var old=ivGet_(msgs[j].getId());if(!old||old.state==='error'){ivProcess_(msgs[j],false);count++;}}
 ivSyncLabels_(threads[i]);if(Date.now()-began>=220000)break;}
 if(i<threads.length)break;offset+=threads.length;if(threads.length<50){done=true;break;}}
 var all=p.getProperties(),errors=Object.keys(all).some(function(k){if(k.indexOf('IV2_MSG_')!==0)return false;try{return JSON.parse(all[k]).state==='error'}catch(e){return true}});
 if(done&&!errors)p.setProperty('INTAKE_V2_WATERMARK',new Date(began).toISOString());
 console.log(JSON.stringify({reviewed:count,scanComplete:done,errorsPending:errors,watermark:p.getProperty('INTAKE_V2_WATERMARK')}));
 }finally{lock.releaseLock();}
}
function runSalesforceLeadIntake(){return runIntakeV2();}
function ivRefreshReview_(m){
 var state=ivGet_(m.getId());if(!state||state.state!=='review'||!state.record||!/^00Q/.test(state.record))return;
 var l=ivQuery_("SELECT Id,Lead_Category__c,Status,IsConverted FROM Lead WHERE Id='"+state.record+"'")[0];if(l&&(l.Lead_Category__c==='New Sales Enquiry'||l.Status==='Unqualified'||l.IsConverted)&&!(state.conflicts||[]).length){state.state='done';state.reason='Administrator reviewed Lead category/status';ivSave_(m.getId(),state);}
}
function enableIntakeV2AfterValidation(){
 throw new Error('Share package cannot auto-enable. Complete PLENTI_ADAPTATION.md and explicitly configure properties and trigger in the new project.');
}
function ivRefreshOutstanding_(deadline){
 var p=PropertiesService.getScriptProperties(),all=p.getProperties(),keys=Object.keys(all).filter(function(k){if(k.indexOf('IV2_MSG_')!==0)return false;try{var s=JSON.parse(all[k]);return s.state==='error'||(s.state==='review'&&s.record&&/^00Q/.test(s.record)&&!(s.conflicts||[]).length)}catch(e){return false}}).sort();
 if(!keys.length){p.deleteProperty('IV2_REVIEW_CURSOR');return;}
 var start=Number(p.getProperty('IV2_REVIEW_CURSOR')||0)%keys.length,n=0;
 while(n<Math.min(keys.length,10)&&Date.now()<deadline){var key=keys[(start+n)%keys.length],id=key.slice(8);n++;try{var m=GmailApp.getMessageById(id);if(!m)continue;var s=ivGet_(id);if(s.state==='error')ivProcess_(m,false);else ivRefreshReview_(m);ivSyncLabels_(m.getThread());}catch(e){console.log('Outstanding intake item '+id+' needs review: '+String(e.message||e).slice(0,180));}}
 p.setProperty('IV2_REVIEW_CURSOR',String((start+n)%keys.length));
}
