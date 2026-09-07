// Synthetic fixtures only. No real customer details and no external writes.
function testIntakeV2Rules(){
 var cases=[
 ['Upgrade','','I am enquiring about options to upgrade my existing system to increase battery capacity. I have no issues with my current setup. You installed my solar in 2021.','sales'],
 ['Investment pitch','GREENFIELD opportunities','Our company is offering investment opportunities for investors and developers.','promotion'],
 ['Inline reply','Re: Solar & Battery Quote','Hi, the address is 19 example st sample town. I think it is 3 phase and I am on 0400000000\nFrom: Sunterra\nPlease reply for a solar quote','reply'],
 ['Multiline reply','Re: Solar & Battery Quote','100 sample street demo town nsw\n3 phase\n0400000000','reply'],
 ['Repair','Help','My inverter is not working. Please repair it.','service'],
 ['Mixed','Help','I want a new battery and my inverter is not working.','review'],
 ['Vague','Hello','Please call me','review'],
 ['Quoted pitch','Re: quote','Here is my address\nFrom: Sales\nWe are offering solar systems','reply'],
 ['Customer question','Solar installation','Can you quote for solar panels at my home?','sales'],
 ['Commercial prospect','Commercial solar','We are looking for a commercial solar installation.','sales'],
 ['Supplier','Solar equipment','We supply solar panels and batteries.','promotion']
 ];cases.forEach(function(c){var got=ivClassify_(c[1],c[2],'customer@example.com').kind;if(got!==c[3])throw new Error(c[0]+': '+got+' expected '+c[3]);});
 var a=ivExtract_('100 sample street demo town nsw\n3 phase\n0400000000');if(a.Street!=='100 sample street'||a.City!=='demo town'||a.StateCode!=='NSW'||a.CountryCode!=='AU'||a.Phone!=='0400000000')throw new Error('Multiline extraction');
 var b=ivExtract_('Hi, the address is 19 example st sample town. I think it is 3 phase and I am on 0400000000');if(b.Street!=='19 example st'||b.City!=='sample town'||b.Phone!=='0400000000')throw new Error('Inline extraction');
 console.log('PASS: 11 classification and 2 field extraction cases');
}
function testIntakeBoundaryCases(){
 testIntakeV2Rules();
 var cases=[['Sandbox: Please follow up Your Unconverted Lead - Test Customer','Hi, your lead needs follow up','email@notice.sfcustomeremail.com','ignore'],['EOI - Trade Assistant - Solar Installation','Dear Recruitment Team, I am enquiring about opportunities for solar installation assistance','applicant@example.com','review'],['TEST2 Sales Enquiries','I would like prices for home batteries','test@example.com','review']];
 cases.forEach(function(c){if(ivClassify_(c[0],c[1],c[2]).kind!==c[3])throw new Error('Boundary failed: '+c[0]);});console.log('PASS: 3 notification/employment/test boundaries');
}
function testReplyAddressRepair(){
 var cases=[{text:'16 example St, Demo Town WA 6000, Australia\nNot sure if 3 phase or single phase.\n0400 000 000',want:{Street:'16 example St',City:'Demo Town',StateCode:'WA',PostalCode:'6000',CountryCode:'AU',Phone:'0400000000'}},{text:'100 sample street demo town nsw\n3 phase\n0400000000',want:{Street:'100 sample street',City:'demo town',StateCode:'NSW',Phone:'0400000000'}},{text:'Hi, the address is 19 example st sample town. I think it is 3 phase and I am on 0400000000',want:{Street:'19 example st',City:'sample town',Phone:'0400000000'}}];
 cases.forEach(function(c){var got=ivExtract_(c.text);Object.keys(c.want).forEach(function(k){if(got[k]!==c.want[k])throw new Error('Address regression: '+k);});});console.log('PASS: 3 reply address cases');
}
function testLeadOnlyLabels(){
 var cases=[[[{kind:'service',state:'review'}],false,false,false],[[{kind:'promotion',state:'done'}],false,false,false],[[{kind:'review',state:'review'}],false,false,false],[[{kind:'sales',state:'review',record:'00Qtest',created:true}],true,true,false],[[{kind:'reply',state:'error'}],false,true,false],[[{kind:'reply',state:'done',record:'00Qtest',verifiedFields:['Street']}],false,false,true],[[{kind:'reply',state:'done',record:'006test',verifiedFields:['Street']}],false,false,false],[[{kind:'reply',state:'done',record:'00Qtest'}],false,false,false]];
 cases.forEach(function(c){var f=ivLeadLabelFlags_(c[0]);if(f.created!==c[1]||f.review!==c[2]||f.updated!==c[3])throw new Error('Label test failed');});console.log('PASS: 8 Lead-only label cases');
}
function testMultilineReplyRepair(){
 testReplyAddressRepair();testLeadOnlyLabels();
 var f=ivExtract_('hello\nits 46a example ave demo town\nsingle phase home\n0400000000');
 if(f.Street!=='46a example ave'||f.City!=='demo town'||f.Phone!=='0400000000'||f.StateCode)throw new Error('Multiline extraction failed');console.log('PASS: multiline address, no inferred state or phase');
}
function testShortSalesEnquiries(){
 testIntakeBoundaryCases();testLeadOnlyLabels();
 var cases=[['Quotes for solar system - WA','Hi\nLooking for quote for comparison:\n6.6kw Maxi Saver; And 11.44kw (25kwh battery) platinum.\nLocation Demo Town, WA. Phone 0400000000','sales'],['Solar enquiry','Seeking a quote for solar panels','sales'],['Solar installation','When is my installation scheduled?','review'],['Battery fault','My battery is not working','service'],['Solar offers','We are offering solar panels. Looking for quotes from buyers','promotion'],['Solar enquiry','Need a quote for solar. My inverter is not working','review']];
 cases.forEach(function(c){var actual=ivClassify_(c[0],c[1],'customer@example.com').kind;if(actual!==c[2])throw new Error('Regression: '+c[0]+' '+actual);});console.log('PASS: 6 short enquiries and non-Lead boundaries');
}
function testPurchaseIntentUpgrade(){
 testShortSalesEnquiries();
 var cases=[['Battery add on SA',"I had solar installed by Sunterra 3 years ago and want to see what my options are in adding in some battery's to the existing system. Could you send me some cost options?",'sales'],['Solar upgrade','Considering adding batteries to our existing system','sales'],['Battery pricing','Battery pricing information','review'],['Installation schedule','When is my solar installation scheduled?','review'],['Battery warranty','My battery is broken. Please repair it','service'],['Solar promotion','We are offering solar systems at low prices','promotion']];
 cases.forEach(function(c){var r=ivClassify_(c[0],c[1],'buyer@example.com');if(r.kind!==c[2])throw new Error('Intent regression '+c[0]+': '+r.kind);});
 var c=ivClassify_('Battery pricing','Battery pricing information','buyer@example.com');if(!c.leadCandidate||!ivLeadLabelFlags_([{kind:c.kind,leadCandidate:c.leadCandidate,state:'review'}]).review)throw new Error('Review visibility failed');console.log('PASS: 6 purchase intent cases and review fallback');
}
function testDescriptionMessageDedup(){
 var m=function(id){return {getId:function(){return id;},getDate:function(){return new Date('2026-09-07T00:00:00Z');},getFrom:function(){return 'test@example.com';},getSubject:function(){return 'Solar enquiry';}};};
 var initial='[Intake: abc123]\nExisting customer CRN_EXAMPLE\nOriginal enquiry',first=m('abc123');
 if(ivSupplementDescription_(initial,first,'Original enquiry')!==initial)throw new Error('Intake repeated');
 var reply=ivSupplementDescription_(initial,m('reply456'),'Additional customer information');
 if(reply.indexOf(initial)!==0||reply.indexOf('Additional customer information')<0)throw new Error('New reply missing');
 if(ivSupplementDescription_(reply,m('reply456'),'Additional customer information')!==reply)throw new Error('Reply repeated');
 if(ivSupplementDescription_('User edited text',m('new789'),'New reply').indexOf('User edited text')!==0)throw new Error('Existing text overwritten');
 if(ivSupplementDescription_('[Intake: abc1234]',first,'Original enquiry').indexOf('[Gmail:abc123]')<0)throw new Error('Partial ID collision');
 var overflow=false;try{ivSupplementDescription_('x'.repeat(32000),m('new789'),'New reply');}catch(e){overflow=true;}if(!overflow)throw new Error('Overflow not guarded');console.log('PASS: 6 Description deduplication cases');
}
function runOfflineRegressionTests(){testPurchaseIntentUpgrade();testMultilineReplyRepair();testDescriptionMessageDedup();}
