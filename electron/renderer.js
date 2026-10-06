let settingsLoaded=false;
let actionPending=false;
let bridgeRunning=false;
let codexPending=false;
let expandedId=null;
let lastRequests=[];
const detailCache=new Map();
const analysisBusy=new Set();
const $=id=>document.getElementById(id);
const cleanIpcError=(err,method)=>String(err?.message||err).replace(new RegExp(`^Error invoking remote method '${method}': (Error: )?`),'');

let pricingCfg=null;
let pricingLoaded=false;

function tokenCost(p,input,cached,output){
 const fresh=Math.max(0,input-cached);
 return fresh*(p.input||0)/1e6+cached*(p.cachedInput||0)/1e6+output*(p.output||0)/1e6;
}
// Tokens Azure served on the fast (priority) tier cost fastMultiplier x the
// standard rate: a single request served fast, or the fast_* share of totals.
function costOf(model,u,tierServed){
 const p=pricingCfg?.[model];
 if(!p||!u)return null;
 if(!(p.input>0||p.cachedInput>0||p.output>0))return null;
 const base=tokenCost(p,u.inputTokens||0,u.cachedTokens||0,u.outputTokens||0);
 const fast=tierServed==='priority'?base:tokenCost(p,u.fastInputTokens||0,u.fastCachedTokens||0,u.fastOutputTokens||0);
 return base+fast*((p.fastMultiplier??2)-1);
}

function fmtCost(c){
 if(c===null)return '';
 if(c>=0.01||c===0)return '$'+c.toFixed(2);
 return '$'+c.toFixed(4);
}

function tokensCell(r){
 if(!r.usage)return '—';
 const cached=r.usage.cachedTokens?` (${r.usage.cachedTokens.toLocaleString()})`:'';
 const cost=costOf(r.model,r.usage,r.tierServed);
 return `${(r.usage.inputTokens||0).toLocaleString()}${cached} / ${(r.usage.outputTokens||0).toLocaleString()}`+(cost===null?'':` · ~${fmtCost(cost)}`);
}

function renderUsage(totals){
 const tbody=$('usage-rows');
 tbody.replaceChildren();
 const periods=[['today','Today'],['week','Last 7 days'],['month','Last 30 days'],['all','All time']];
 for(const [keyName,label] of periods){
  const models=totals?.[keyName]||{};
  const sum={requests:0,inputTokens:0,cachedTokens:0,outputTokens:0};
  let cost=0,costKnown=false,costMissing=false;
  for(const [model,u] of Object.entries(models)){
   for(const f of ['requests','inputTokens','cachedTokens','outputTokens'])sum[f]+=u[f]||0;
   const c=costOf(model,u);
   if(c===null){if(u.requests)costMissing=true;}
   else{cost+=c;costKnown=true;}
  }
  const tr=document.createElement('tr');
  const cached=sum.cachedTokens?` (${sum.cachedTokens.toLocaleString()})`:'';
  const costText=costKnown?`~${fmtCost(cost)}${costMissing?' *':''}`:(sum.requests?'Set rates below':'—');
  for(const value of [label,String(sum.requests),`${sum.inputTokens.toLocaleString()}${cached}`,sum.outputTokens.toLocaleString(),costText]){
   const td=document.createElement('td');
   td.textContent=value;
   tr.append(td);
  }
  tbody.append(tr);
 }
}

function fmtWait(ms){
 if(!ms)return '0s';
 if(ms<1000)return `${Math.round(ms)}ms`;
 const s=ms/1000;
 return s<60?`${s.toFixed(s<10?1:0)}s`:`${Math.floor(s/60)}m ${Math.round(s%60)}s`;
}
const fmtTok=n=>Math.round(n||0).toLocaleString();

function renderQueue(live,models){
 const box=$('queue-live');
 box.replaceChildren();
 const budgeted=(models||[]).filter(m=>m.tokensPerMinute>0);
 const byDeployment=new Map((live?.deployments||[]).map(d=>[d.deployment,d]));
 if(!live){
  const p=document.createElement('p');
  p.className='queue-meta';
  p.textContent='Live queue unavailable — the bridge is not running.';
  box.append(p);
 }
 for(const m of budgeted){
  const d=byDeployment.get(m.deployment);
  const limit=m.tokensPerMinute;
  // Before its first request a model's budget is full.
  const raw=d?d.available:limit;
  const available=Math.max(0,Math.min(limit,raw));
  const pct=100*available/limit;
  const card=document.createElement('div');
  card.className='queue-model';
  const head=document.createElement('div');
  head.className='queue-head';
  const name=document.createElement('b');
  name.textContent=`${(m.label||m.id).replace(/^Azure · /,'')} (${m.id})`;
  const badges=document.createElement('span');
  const waiting=d?.waiting||[];
  if(d?.pausedForMs>0){const b=document.createElement('span');b.className='badge hot';b.textContent=`Azure throttled · paused ${fmtWait(d.pausedForMs)}`;badges.append(b);}
  if(waiting.length){const b=document.createElement('span');b.className='badge warn';b.textContent=`${waiting.length} waiting`;badges.append(b);}
  if(!waiting.length&&!(d?.pausedForMs>0)){const b=document.createElement('span');b.className='badge';b.textContent='flowing';badges.append(b);}
  head.append(name,badges);
  const track=document.createElement('div');
  track.className='budget-track';
  const fill=document.createElement('div');
  fill.className='budget-fill'+(pct<5?' empty':pct<25?' low':'');
  fill.style.width=`${pct.toFixed(1)}%`;
  track.append(fill);
  const meta=document.createElement('div');
  meta.className='queue-meta';
  meta.textContent=`${fmtTok(available)} of ${fmtTok(limit)} tokens available this minute · refills ${fmtTok(limit/60)} per second`+(raw<0?` · ${fmtTok(-raw)} over budget after a large request, refilling`:'');
  card.append(head,track,meta);
  if(waiting.length){
   const table=document.createElement('table');
   table.className='queue-waiting';
   const thead=document.createElement('thead');
   thead.innerHTML='<tr><th>Waiting request</th><th>Needs</th><th>Waited</th><th></th></tr>';
   const tbody=document.createElement('tbody');
   for(const w of waiting){
    const tr=document.createElement('tr');
    const tags=[w.priority?'next up (priority)':'',w.oversized?'larger than the whole budget — goes alone when full':''].filter(Boolean).join(' · ');
    for(const value of [`${w.client||'client'} · ${w.model||m.id}`,`${fmtTok(w.tokens)} tokens`,fmtWait(w.waitedMs),tags]){
     const td=document.createElement('td');
     td.textContent=value;
     tr.append(td);
    }
    tbody.append(tr);
   }
   table.append(thead,tbody);
   card.append(table);
  }
  box.append(card);
 }
 const free=(models||[]).filter(m=>!(m.tokensPerMinute>0)).map(m=>m.id);
 if(free.length){
  const p=document.createElement('p');
  p.className='queue-meta';
  p.textContent=`No budget — requests flow freely without queuing: ${free.join(', ')}. Set a TPM on a model's card to queue it.`;
  box.append(p);
 }
}

function renderQueueStats(stats){
 const tbody=$('queue-stats');
 tbody.replaceChildren();
 let rows=0;
 for(const [key,label] of [['today','Today'],['week','Last 7 days']]){
  for(const [model,q] of Object.entries(stats?.[key]||{})){
   if(!q.admitted&&!q.throttled)continue;
   rows++;
   const tr=document.createElement('tr');
   const pctWaited=q.admitted?Math.round(100*q.queued/q.admitted):0;
   const avg=q.queued?q.waitMs/q.queued:0;
   for(const value of [model,label,String(q.admitted),`${q.queued} (${pctWaited}%)`,q.queued?`${fmtWait(avg)} / ${fmtWait(q.maxWaitMs)}`:'—',String(q.jumped),String(q.throttled)]){
    const td=document.createElement('td');
    td.textContent=value;
    tr.append(td);
   }
   tbody.append(tr);
  }
 }
 $('queue-stats-empty').hidden=rows>0;
}

function renderUsageDays(days){
 const tbody=$('usage-days');
 tbody.replaceChildren();
 $('usage-days-empty').hidden=(days||[]).length>0;
 let maxCost=0;
 const rows=(days||[]).map(d=>{
  const sum={requests:0,inputTokens:0,cachedTokens:0,outputTokens:0};
  let cost=0,costKnown=false;
  for(const [model,u] of Object.entries(d.models||{})){
   for(const f of ['requests','inputTokens','cachedTokens','outputTokens'])sum[f]+=u[f]||0;
   const c=costOf(model,u);
   if(c!==null){cost+=c;costKnown=true;}
  }
  if(costKnown)maxCost=Math.max(maxCost,cost);
  return {day:d.day,sum,cost:costKnown?cost:null};
 });
 for(const r of rows){
  const tr=document.createElement('tr');
  const cached=r.sum.cachedTokens?` (${r.sum.cachedTokens.toLocaleString()})`:'';
  for(const value of [r.day,String(r.sum.requests),`${r.sum.inputTokens.toLocaleString()}${cached}`,r.sum.outputTokens.toLocaleString(),r.cost===null?'—':`~${fmtCost(r.cost)}`]){
   const td=document.createElement('td');
   td.textContent=value;
   tr.append(td);
  }
  const barTd=document.createElement('td');
  if(r.cost!==null&&maxCost>0){
   const bar=document.createElement('div');
   bar.className='mini-bar';
   bar.style.width=Math.max(2,Math.round(100*r.cost/maxCost))+'%';
   barTd.append(bar);
  }
  tr.append(barTd);
  tbody.append(tr);
 }
}

let lastModels=[];
let modelCardsSig='';
function renderModelCards(models,modelSettings){
 const sig=JSON.stringify((models||[]).map(m=>[m.id,m.contextWindow,m.maxInputTokens,m.maxOutputTokens,m.tokensPerMinute,m.defaultEffort,modelSettings?.[m.id]?.effort,m.fast,m.fastSupported]));
 if(sig===modelCardsSig)return;
 modelCardsSig=sig;
 const grid=$('model-cards');
 grid.replaceChildren();
 for(const m of models||[]){
  const card=document.createElement('article');
  card.className='panel';
  const name=document.createElement('div');
  name.className='modelname';
  name.textContent=(m.label||m.id).replace(/^Azure · /,'');
  const idCode=document.createElement('code');
  idCode.textContent=m.id;
  const dep=document.createElement('p');
  dep.textContent=(m.protocol==='claude-cli'?`Claude CLI model: ${m.deployment} · your Claude subscription`:m.protocol==='chatgpt'?`ChatGPT plan model: ${m.deployment} · your ChatGPT sign-in · owner key only`:`Azure deployment: ${m.deployment}`)+(m.builtin?'':' · custom'+(m.protocol==='chat'?' · chat completions':''));
  const label=document.createElement('label');
  label.textContent='Reasoning mode';
  label.htmlFor=`effort-${m.id}`;
  const sel=document.createElement('select');
  sel.id=`effort-${m.id}`;
  for(const [v,t] of [['low','Low'],['medium','Medium'],['high','High'],['xhigh','Extra High'],['max','Max']]){
   const o=document.createElement('option');
   o.value=v;o.textContent=t;
   sel.append(o);
  }
  sel.value=m.builtin?(modelSettings?.[m.id]?.effort||'medium'):(m.defaultEffort||'medium');
  sel.addEventListener('change',()=>saveModelCard(m));
  const saved=document.createElement('p');
  saved.className='card-saved';
  saved.id=`saved-${m.id}`;
  saved.setAttribute('role','status');
  const recent=cardNotes[m.id];
  if(recent&&Date.now()-recent.at<6000)saved.textContent=recent.text;
  const override=document.createElement('p');
  override.className='card-note';
  override.textContent=`Cursor uses this unless you pick an effort-suffixed name such as ${m.id}-high. Codex always sends its own reasoning choice, which takes precedence.`;
  const ctx=document.createElement('p');
  ctx.textContent=`Maximum context: ${(m.contextWindow||0).toLocaleString()} tokens`+(m.maxInputTokens?` (up to ${m.maxInputTokens.toLocaleString()} input)`:'');
  const out=document.createElement('p');
  out.textContent=`Output allowance: up to ${(m.maxOutputTokens||128000).toLocaleString()} tokens`;
  const tpm=document.createElement('p');
  tpm.textContent=`Local TPM budget: ${m.tokensPerMinute?m.tokensPerMinute.toLocaleString():'Off'}`;
  let fast;
  if(m.fastSupported){
   fast=document.createElement('label');
   fast.className='fast-toggle';
   const cb=document.createElement('input');
   cb.type='checkbox';
   cb.id=`fast-${m.id}`;
   cb.checked=m.fast===true;
   cb.addEventListener('change',()=>saveModelCard(m));
   const text=document.createElement('span');
   text.textContent='Fast mode — Azure priority processing: faster responses, billed at the fast-mode rate';
   fast.append(cb,text);
  }else{
   fast=document.createElement('p');
   fast.className='fast-note';
   fast.textContent=m.protocol==='claude-cli'||m.protocol==='anthropic'||m.protocol==='chatgpt'?'Fast mode: not available for this model through the bridge':'Fast mode: Azure does not offer priority processing for this model yet';
  }
  card.append(name,idCode,dep,label,sel,saved,override,fast,ctx,out,tpm);
  grid.append(card);
 }
}
// Reasoning mode and fast mode save the moment they change. Saving re-renders
// the cards, so the confirmation is kept here for a few seconds.
const cardNotes={};
async function saveModelCard(m){
 const sel=$(`effort-${m.id}`),fastCb=$(`fast-${m.id}`);
 const note=text=>{cardNotes[m.id]={text,at:Date.now()};const el=$(`saved-${m.id}`);if(el)el.textContent=text;};
 const fast=fastCb?fastCb.checked:m.fast===true;
 note('Saving…');
 try{
  if(m.builtin)await window.azureBridge.saveSettings({[m.id]:{effort:sel.value,...(fastCb?{fast}:{})}});
  else await window.azureBridge.models({action:'save',model:{id:m.id,label:m.label,deployment:m.deployment,protocol:m.protocol,contextWindow:m.contextWindow,maxOutputTokens:m.maxOutputTokens,tokensPerMinute:m.tokensPerMinute||0,defaultEffort:sel.value,fast}});
  note(`Saved — ${sel.selectedOptions[0]?.textContent||sel.value} applies to the next request`);
 }catch(err){
  note(String(err?.message||err).replace(/^Error invoking remote method '[^']+': (Error: )?/,''));
 }
 await refresh();
}
let pricingModelsSig='';
function renderPricingForm(models,pricing){
 const sig=(models||[]).map(m=>m.id+(m.fastSupported?'*':'')).join(',');
 if(sig===pricingModelsSig)return;
 pricingModelsSig=sig;
 const grid=$('pricing-grid');
 grid.replaceChildren();
 for(const m of models||[]){
  const row=document.createElement('div');
  row.className='pricing-row';
  const name=document.createElement('span');
  name.textContent=`${m.label||m.id} (${m.id})`;
  row.append(name);
  for(const [field,labelText] of [['input','Input $/1M'],['cachedInput','Cached input $/1M'],['output','Output $/1M']]){
   const label=document.createElement('label');
   label.textContent=labelText;
   const input=document.createElement('input');
   input.type='number';input.min='0';input.step='0.01';
   input.id=`price-${m.id}-${field}`;
   const v=pricing?.[m.id]?.[field];
   if(v!==undefined&&v!==null)input.value=v;
   label.append(input);
   row.append(label);
  }
  if(m.fastSupported){
   row.classList.add('has-fast');
   const label=document.createElement('label');
   label.textContent='Fast mode ×';
   label.title='Rate multiplier applied to tokens Azure served in fast mode (priority processing). OpenAI bills fast mode at 2×; check your Azure rate card.';
   const input=document.createElement('input');
   input.type='number';input.min='1';input.max='10';input.step='0.1';
   input.id=`price-${m.id}-fastMultiplier`;
   input.value=pricing?.[m.id]?.fastMultiplier??2;
   label.append(input);
   row.append(label);
  }
  grid.append(row);
 }
}

let editingBuiltinId=null;
function resetModelForm(){
 editingBuiltinId=null;
 for(const id of ['cm-id','cm-label','cm-deployment','cm-protocol','cm-context'])$(id).disabled=false;
 $('cm-id').value='';$('cm-label').value='';$('cm-deployment').value='';
 $('cm-protocol').value='responses';$('cm-context').value=1000000;
 $('cm-maxout').value=128000;$('cm-tpm').value=0;$('cm-effort').value='medium';
 $('cm-save').textContent='Add / update model';$('cm-cancel').hidden=true;
}
function editModel(m){
 editingBuiltinId=m.builtin?m.id:null;
 $('cm-id').value=m.id;$('cm-label').value=m.label||'';$('cm-deployment').value=m.deployment;
 $('cm-protocol').value=m.protocol;$('cm-context').value=m.contextWindow||1000000;
 $('cm-maxout').value=m.maxOutputTokens||128000;$('cm-tpm').value=m.tokensPerMinute||0;
 $('cm-effort').value=m.defaultEffort||m.effort||'medium';
 for(const id of ['cm-id','cm-label','cm-deployment','cm-protocol','cm-context'])$(id).disabled=Boolean(m.builtin);
 $('cm-save').textContent=m.builtin?'Save Azure model':'Update custom model';$('cm-cancel').hidden=false;
 $('cm-maxout').focus();
}
let modelListSig='';
function renderCustomModels(models){
 const sig=JSON.stringify((models||[]).map(m=>[m.id,m.label,m.deployment,m.protocol,m.contextWindow,m.maxOutputTokens,m.tokensPerMinute,m.defaultEffort,m.effort]));
 if(sig===modelListSig)return;
 modelListSig=sig;
 const tbody=$('custom-models');
 tbody.replaceChildren();
 for(const m of models||[]){
  const tr=document.createElement('tr');
  for(const value of [m.id+(m.builtin?' · Azure':''),m.deployment,{responses:'OpenAI',anthropic:'Anthropic',chat:'Chat completions','claude-cli':'Claude CLI',chatgpt:'ChatGPT plan'}[m.protocol]||m.protocol,(m.contextWindow||0).toLocaleString(),(m.maxOutputTokens||128000).toLocaleString(),m.tokensPerMinute?m.tokensPerMinute.toLocaleString():'Off',m.defaultEffort||m.effort||'medium']){
   const td=document.createElement('td');
   td.textContent=value;
   tr.append(td);
  }
  const td=document.createElement('td');
  const eb=document.createElement('button');
  eb.className='mini';
  eb.textContent='Edit';
  eb.addEventListener('click',()=>editModel(m));
  td.append(eb);
  if(!m.builtin){
   const rb=document.createElement('button');
   rb.className='mini';
   rb.textContent='Remove';
   rb.addEventListener('click',async()=>{
    if(!confirm(`Remove model “${m.id}”? Requests to it will fail closed.`))return;
    try{const r=await window.azureBridge.models({action:'delete',id:m.id});$('cm-message').textContent=r.message;}
    catch(err){$('cm-message').textContent=cleanIpcError(err,'azure:models');}
    await refresh();
   });
   td.append(rb);
  }
  tr.append(td);
  tbody.append(tr);
 }
}

let playModelsSig='';
function renderPlayModels(models){
 const sig=(models||[]).map(m=>m.id).join(',');
 if(sig===playModelsSig)return;
 playModelsSig=sig;
 const sel=$('play-model');
 const current=sel.value;
 sel.replaceChildren();
 for(const m of models||[]){
  const o=document.createElement('option');
  o.value=m.id;
  o.textContent=`${m.label||m.id} (${m.id})`;
  sel.append(o);
 }
 if([...sel.options].some(o=>o.value===current))sel.value=current;
}

// Claude and ChatGPT plans share one switcher: a list of the signed-in plans
// (one is used at a time), plus sign in / log in again / remove.
const planLabel=a=>a&&a.plan?a.plan[0].toUpperCase()+a.plan.slice(1)+' plan':'';
const claudeOrgPlan=a=>a?[a.org,planLabel(a)].filter(Boolean).join(' · ')||'—':'—';
const chatgptPlan=a=>{
 if(!a)return '—';
 if(a.method==='api-key')return 'API key (no ChatGPT plan)';
 const until=a.activeUntil&&!Number.isNaN(Date.parse(a.activeUntil))?` · renews ${new Date(a.activeUntil).toLocaleDateString()}`:'';
 return (planLabel(a)||'—')+until;
};
const ACCOUNT_KINDS={
 claude:{name:'Claude',cli:'Claude Code',call:r=>window.azureBridge.claudeAccount(r),plan:claudeOrgPlan,via:a=>a.method&&a.method!=='claude.ai'?` · via ${a.method}`:''},
 chatgpt:{name:'ChatGPT',cli:'Codex',call:r=>window.azureBridge.chatgptAccount(r),plan:chatgptPlan,via:()=>''},
};
async function accountAction(kind,request){
 try{const r=await ACCOUNT_KINDS[kind].call(request);$(`${kind}-message`).textContent=r.message;}
 catch(err){$(`${kind}-message`).textContent=String(err?.message||err).replace(/^Error invoking remote method '[^']+': (Error: )?/,'');}
 await refresh();
}
function describePlan(kind,a){
 const k=ACCOUNT_KINDS[kind];
 const own=a.id==='default'?` (this computer’s ${k.cli} login)`:'';
 if(!a.account)return a.id==='default'?`This computer’s ${k.cli} login — not signed in`:`${a.label} — not signed in`;
 return `${k.plan(a.account)} — ${a.account.email||'signed in'}${own}`;
}
const accountState={};
function renderAccountPanel(kind,s){
 if(!s)return;
 accountState[kind]=s;
 const k=ACCOUNT_KINDS[kind];
 const a=s.loggedIn&&s.account;
 $(`${kind}-account`).textContent=a?(a.email||'(email not reported)')+k.via(a):s.checked?'not signed in':'checking…';
 $(`${kind}-org`).textContent=k.plan(a);
 $(`${kind}-login`).hidden=!s.installed||!s.checked||s.loggedIn;
 const accounts=s.accounts||[];
 const choices=accounts.filter(x=>x.loggedIn||x.active);
 const pending=accounts.filter(x=>!x.loggedIn&&!x.active&&x.checked);
 const sel=$(`${kind}-plan`);
 if(document.activeElement!==sel){
  const sig=JSON.stringify(choices.map(x=>[x.id,x.loggedIn,x.account]));
  if(sel.dataset.sig!==sig){
   sel.dataset.sig=sig;
   sel.replaceChildren(...choices.map(x=>{const o=document.createElement('option');o.value=x.id;o.textContent=describePlan(kind,x);return o;}));
  }
  sel.value=s.active;
 }
 sel.disabled=choices.length<2;
 $(`${kind}-remove`).disabled=s.active==='default';
 $(`${kind}-relogin`).disabled=!s.installed;
 const box=$(`${kind}-pending`);
 const psig=JSON.stringify(pending.map(x=>x.id));
 if(box.dataset.sig!==psig){
  box.dataset.sig=psig;
  box.replaceChildren();
  box.hidden=!pending.length;
  if(pending.length){
   box.append('Sign-in not finished: ');
   for(const p of pending){
    const name=document.createElement('b');
    name.textContent=p.label;
    const finish=document.createElement('button');
    finish.className='mini';finish.textContent='Finish sign-in';
    finish.addEventListener('click',()=>accountAction(kind,{action:'login',id:p.id}));
    const drop=document.createElement('button');
    drop.className='mini';drop.textContent='Remove';
    drop.addEventListener('click',()=>accountAction(kind,{action:'remove',id:p.id}));
    box.append(name,finish,drop,' ');
   }
  }
 }
}
for(const kind of Object.keys(ACCOUNT_KINDS)){
 const k=ACCOUNT_KINDS[kind];
 $(`${kind}-plan`).addEventListener('change',e=>{
  const id=e.target.value;
  e.target.blur();
  if(id!==accountState[kind]?.active)accountAction(kind,{action:'use',id});
 });
 $(`${kind}-login`).addEventListener('click',()=>accountAction(kind,{action:'login-active'}));
 $(`${kind}-add`).addEventListener('click',async()=>{
  const button=$(`${kind}-add`);
  button.disabled=true;
  try{await accountAction(kind,{action:'add'});}finally{button.disabled=false;}
 });
 $(`${kind}-relogin`).addEventListener('click',()=>{
  const s=accountState[kind];
  if(!s)return;
  if(s.active==='default'&&s.loggedIn&&!confirm(`Logging in again here also changes the account ${k.cli} itself uses on this computer. To add your other plan without changing that, use “Sign in to another plan” instead. Continue?`))return;
  accountAction(kind,{action:'login',id:s.active});
 });
 $(`${kind}-remove`).addEventListener('click',()=>{
  const s=accountState[kind];
  if(!s||s.active==='default')return;
  if(confirm(`Remove this ${k.name} plan from the bridge? It is signed out and its login is deleted from this computer, and the bridge goes back to this computer’s own ${k.cli} login.`))accountAction(kind,{action:'remove',id:s.active});
 });
}

$('cm-save').addEventListener('click',async()=>{
 const button=$('cm-save');
 button.disabled=true;
 try{
  const r=await window.azureBridge.models({action:editingBuiltinId?'save-builtin':'save',model:{id:$('cm-id').value,label:$('cm-label').value,deployment:$('cm-deployment').value,protocol:$('cm-protocol').value,contextWindow:Number($('cm-context').value),maxOutputTokens:Number($('cm-maxout').value),tokensPerMinute:Number($('cm-tpm').value),defaultEffort:$('cm-effort').value}});
  $('cm-message').textContent=r.message;
  resetModelForm();
 }catch(err){
  $('cm-message').textContent=cleanIpcError(err,'azure:models');
 }finally{
  button.disabled=false;
  await refresh();
 }
});
$('cm-cancel').addEventListener('click',resetModelForm);

function toggleDetail(id){
 expandedId=expandedId===id?null:id;
 if(expandedId===id&&!detailCache.has(id)){
  window.azureBridge.requestDetail(id)
   .then(d=>{detailCache.set(id,d);renderRequests(lastRequests);})
   .catch(err=>{detailCache.set(id,{error:cleanIpcError(err,'azure:request-detail')});renderRequests(lastRequests);});
 }
 renderRequests(lastRequests);
}

function buildDetailRow(id){
 const tr=document.createElement('tr');
 tr.className='detail-row';
 const td=document.createElement('td');
 td.colSpan=5;
 tr.append(td);
 const d=detailCache.get(id);
 if(d===undefined){td.textContent='Loading breakdown…';return tr;}
 if(d.error){td.textContent=d.error;return tr;}
 const wrap=document.createElement('div');
 wrap.className='detail-wrap';
 td.append(wrap);
 const meta=document.createElement('p');
 meta.textContent=`${d.client||'Unknown client'} · via ${d.via==='public'?'public URL (through Cloudflare)':'localhost'} · ${d.protocol} protocol · effort ${d.effort}`+(d.userAgent?` · UA: ${d.userAgent}`:'');
 wrap.append(meta);
 if(d.trim){
  const t=d.trim,saved=Math.max(0,t.beforeChars-t.afterChars);
  const parts=[t.shortened&&`${t.shortened} shortened`,t.deduped&&`${t.deduped} duplicates removed`,t.cleaned&&`${t.cleaned} tidied`,t.imagesRemoved&&`${t.imagesRemoved} old images removed`,t.summarizedTurns&&`${t.summarizedTurns} early turns summarized${t.summaryCached?' (cached)':''}`,t.summaryError&&`summary failed: ${t.summaryError}`].filter(Boolean);
  const line=document.createElement('p');
  line.className='trim-line';
  line.textContent=`Bloat remover (${t.level}): ${t.beforeChars.toLocaleString()} → ${t.afterChars.toLocaleString()} characters of conversation sent upstream (−${t.beforeChars?Math.round(saved/t.beforeChars*100):0}%, about ${Math.round(saved/4).toLocaleString()} tokens)${parts.length?' · '+parts.join(' · '):''}. The breakdown below shows what the client sent.`;
  wrap.append(line);
 }
 const u=d.result?.usage;
 if(u){
  const fresh=Math.max(0,(u.inputTokens||0)-(u.cachedTokens||0));
  const cost=costOf(d.model,u,d.result?.tierServed);
  const um=document.createElement('p');
  um.textContent=`Exact usage: ${(u.inputTokens||0).toLocaleString()} tokens in — ${(u.cachedTokens||0).toLocaleString()} served from Azure's prompt cache, ${fresh.toLocaleString()} fresh — ${(u.outputTokens||0).toLocaleString()} out.`+(cost===null?'':` Estimated cost: ${fmtCost(cost)} at your saved rates.`);
  wrap.append(um);
 }
 const groups={scaffolding:{label:'Scaffolding (instructions & tools)',est:0,parts:[]},conversation:{label:'Conversation (messages & tool flow)',est:0,parts:[]}};
 for(const c of Object.values(d.categories||{})){
  const g=groups[c.group]||groups.conversation;
  g.est+=c.estTokens||0;
  if(c.count)g.parts.push(`${c.label}: ~${(c.estTokens||0).toLocaleString()} tok (${c.count})`);
 }
 for(const g of Object.values(groups)){
  const p=document.createElement('p');
  p.className='group-line';
  p.textContent=`${g.label}: ~${g.est.toLocaleString()} tokens est.`+(g.parts.length?` — ${g.parts.join(' · ')}`:' — none');
  wrap.append(p);
 }
 const bar=document.createElement('div');
 bar.className='bar';
 const colors={system:'#5b8dd9',tools:'#8a6fd6',user:'#4db6a0',assistant:'#c9a24b',toolflow:'#c96b5b'};
 const total=Math.max(1,d.estTokens||1);
 for(const [k,c] of Object.entries(d.categories||{})){
  if(!c.chars)continue;
  const seg=document.createElement('span');
  seg.style.width=(100*(c.estTokens||0)/total)+'%';
  seg.style.background=colors[k]||'#666';
  seg.title=`${c.label}: ~${(c.estTokens||0).toLocaleString()} tokens`;
  bar.append(seg);
 }
 wrap.append(bar);
 const msgs=document.createElement('div');
 msgs.className='msg-list';
 for(const m of (d.messages||[]).slice(0,40)){
  const row=document.createElement('div');
  row.className='msg';
  const head=document.createElement('b');
  head.textContent=`${m.role} · ~${Math.ceil((m.chars||0)/4).toLocaleString()} tok`;
  const body=document.createElement('span');
  body.textContent=' '+(m.preview||'').slice(0,200);
  row.append(head,body);
  msgs.append(row);
 }
 if((d.messages||[]).length>40){
  const more=document.createElement('div');
  more.className='msg';
  more.textContent=`… ${d.messages.length-40} more parts`;
  msgs.append(more);
 }
 wrap.append(msgs);
 const actions=document.createElement('div');
 actions.className='actions';
 const btn=document.createElement('button');
 btn.textContent=analysisBusy.has(id)?'Analyzing…':(d.analysis?.text?'Re-analyze with AI':'Analyze with AI');
 btn.disabled=analysisBusy.has(id);
 btn.addEventListener('click',async e=>{
  e.stopPropagation();
  analysisBusy.add(id);
  renderRequests(lastRequests);
  try{
   const text=await window.azureBridge.analyze(id,Boolean(d.analysis?.text));
   d.analysis={text};
  }catch(err){
   d.analysis={text:'Analysis failed: '+cleanIpcError(err,'azure:analyze')};
  }finally{
   analysisBusy.delete(id);
   renderRequests(lastRequests);
  }
 });
 actions.append(btn);
 wrap.append(actions);
 if(d.analysis?.text){
  const an=document.createElement('p');
  an.className='analysis';
  an.textContent=d.analysis.text;
  wrap.append(an);
 }
 return tr;
}

document.querySelectorAll('#nav button').forEach(button=>button.addEventListener('click',()=>{
 document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active',b===button));
 document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.dataset.page===button.dataset.page));
}));

let wizardDismissed=false;
let wizardShown=false;
function maybeShowWizard(azureKey){
 const needsSetup=azureKey&&(!azureKey.endpoint||!azureKey.active);
 if(needsSetup&&!wizardDismissed&&!wizardShown){wizardShown=true;$('wizard').hidden=false;}
 if(!needsSetup&&wizardShown){wizardShown=false;$('wizard').hidden=true;}
}
$('wiz-skip').addEventListener('click',()=>{wizardDismissed=true;$('wizard').hidden=true;});
$('wiz-save').addEventListener('click',async()=>{
 const endpoint=$('wiz-endpoint').value.trim();
 const value=$('wiz-key').value.trim();
 if(!endpoint||!value){$('wiz-message').textContent='Enter both the endpoint and the key.';return;}
 $('wiz-save').disabled=true;
 $('wiz-message').textContent='Saving and starting the bridge…';
 try{
  const r=await window.azureBridge.azureKey({action:'set',endpoint,value,note:'First-run setup'});
  $('wiz-message').textContent=r.message;
  wizardDismissed=true;
  $('wizard').hidden=true;
 }catch(err){
  $('wiz-message').textContent=cleanIpcError(err,'azure:azure-key');
 }finally{
  $('wiz-save').disabled=false;
  await refresh();
 }
});

function docSnippets(baseUrl){
 const base=baseUrl||'https://<your-bridge-url>';
 $('doc-codex').textContent=`model = "azure-astra"\nmodel_provider = "azure_cursor_bridge"\n\n[model_providers.azure_cursor_bridge]\nname = "Azure Cursor Bridge"\nbase_url = "${base}"\nenv_key = "AZURE_CURSOR_BRIDGE_API_KEY"\nwire_api = "responses"`;
 const origin=base.replace(/\/v1$/,'');
 $('doc-curl').textContent=`curl ${origin}/health\n\ncurl -H "Authorization: Bearer <bridge key>" ${origin}/v1/models\n\ncurl -X POST ${origin}/v1/chat/completions \\\n  -H "Authorization: Bearer <bridge key>" -H "Content-Type: application/json" \\\n  -d '{"model":"azure-astra","messages":[{"role":"user","content":"Say hi"}]}'`;
}

let azRevealed=false;

async function azAction(cmd,button){
 if(button)button.disabled=true;
 try{
  const r=await window.azureBridge.azureKey(cmd);
  if(r?.message)$('az-message').textContent=r.message;
  return r;
 }catch(err){
  $('az-message').textContent=cleanIpcError(err,'azure:azure-key');
  return null;
 }finally{
  if(button)button.disabled=false;
 }
}

function renderAzureKey(info){
 if(!info)return;
 $('az-endpoint').textContent=info.endpoint||'Not configured — set it below';
 const active=(info.versions||[]).find(v=>v.isActive);
 $('az-active').textContent=active?`v${active.v} · ${active.fingerprint}`:'No key stored';
 const tbody=$('az-versions');
 tbody.replaceChildren();
 for(const v of (info.versions||[]).slice().reverse()){
  const tr=document.createElement('tr');
  for(const value of [`v${v.v}`,new Date(v.createdAt).toLocaleString(),v.fingerprint,(v.endpoint||'').replace(/^https:\/\//,''),v.note||'',v.isActive?'active':'—']){
   const td=document.createElement('td');
   td.textContent=value;
   tr.append(td);
  }
  tr.children[5].className=v.isActive?'ok':'';
  const td=document.createElement('td');
  const mk=(text,handler,confirmText)=>{
   const b=document.createElement('button');
   b.className='mini';
   b.textContent=text;
   b.addEventListener('click',async()=>{if(confirmText&&!confirm(confirmText))return;await handler(b);await refresh();});
   return b;
  };
  td.append(mk('Test',b=>azAction({action:'test',v:v.v},b)));
  td.append(mk('Reveal',async b=>{
   const r=await azAction({action:'reveal',v:v.v},b);
   if(r?.value){$('az-revealed').textContent=`v${r.v}\nendpoint: ${r.endpoint}\nkey: ${r.value}`;$('az-revealed').hidden=false;azRevealed=true;$('az-reveal').textContent='Hide';}
  }));
  td.append(mk('Copy',b=>azAction({action:'copy',v:v.v},b)));
  if(!v.isActive){
   td.append(mk('Activate',b=>azAction({action:'activate',v:v.v},b),`Revert to configuration v${v.v}? The proxy restarts and Azure calls use that endpoint and key immediately.`));
   td.append(mk('Delete',b=>azAction({action:'delete',v:v.v},b),`Delete configuration v${v.v} permanently?`));
  }
  tr.append(td);
  tbody.append(tr);
 }
}

$('az-reveal').addEventListener('click',async()=>{
 if(azRevealed){
  azRevealed=false;
  $('az-revealed').hidden=true;
  $('az-revealed').textContent='';
  $('az-reveal').textContent='Reveal';
  return;
 }
 const r=await azAction({action:'reveal'},$('az-reveal'));
 if(r?.value){
  azRevealed=true;
  $('az-revealed').textContent=`active (v${r.v})\nendpoint: ${r.endpoint}\nkey: ${r.value}`;
  $('az-revealed').hidden=false;
  $('az-reveal').textContent='Hide';
 }
});

$('az-copy').addEventListener('click',()=>azAction({action:'copy'},$('az-copy')));

$('az-test').addEventListener('click',async()=>{
 $('az-message').textContent='Testing against Azure…';
 const r=await azAction({action:'test'},$('az-test'));
 if(r)$('az-message').textContent=r.message;
});

$('az-endpoint-save').addEventListener('click',async()=>{
 const endpoint=$('az-endpoint-input').value.trim();
 if(!endpoint){$('az-message').textContent='Enter the Azure resource origin first.';return;}
 if(!confirm('Save a new configuration version with this endpoint (keeping the current key)? The proxy restarts and all requests go to it immediately.'))return;
 $('az-message').textContent='Saving and restarting the proxy…';
 const r=await azAction({action:'set',endpoint},$('az-endpoint-save'));
 if(r)$('az-endpoint-input').value='';
 await refresh();
});

$('az-save').addEventListener('click',async()=>{
 const value=$('az-new').value.trim();
 const endpoint=$('az-endpoint-input').value.trim();
 if(!value&&!endpoint){$('az-message').textContent='Paste a new key, a new endpoint, or both.';return;}
 if(!confirm('Save this as a new configuration version (endpoint + key) and activate it? The proxy restarts and Azure calls use it immediately.'))return;
 $('az-message').textContent='Saving and restarting the proxy…';
 const r=await azAction({action:'set',value,endpoint},$('az-save'));
 if(r){$('az-new').value='';$('az-endpoint-input').value='';}
 await refresh();
});

let expandedKeyId=null;
let lastKeys=[];
function renderKeys(list){
 lastKeys=list||[];
 const tbody=$('keys');
 tbody.replaceChildren();
 for(const k of list||[]){
  const tr=document.createElement('tr');
  const status=k.permanent?'permanent':k.status;
  const expires=k.permanent?'Never (until rotated)':k.expiresAt?new Date(k.expiresAt).toLocaleString():'Never';
  for(const value of [k.label,k.masked,status,expires,k.permanent?'—':String(k.requests??0)]){
   const td=document.createElement('td');
   td.textContent=value;
   tr.append(td);
  }
  tr.children[2].className=(status==='active'||status==='permanent')?'ok':'failed';
  const td=document.createElement('td');
  const mk=(text,action,confirmText)=>{
   const b=document.createElement('button');
   b.className='mini';
   b.textContent=text;
   b.addEventListener('click',async()=>{
    if(confirmText&&!confirm(confirmText))return;
    b.disabled=true;
    try{const r=await window.azureBridge.keys({action,id:k.id});$('keys-message').textContent=r.message;}
    catch(err){$('keys-message').textContent=cleanIpcError(err,'azure:keys');}
    await refresh();
   });
   return b;
  };
  td.append(mk('Copy','copy'));
  if(k.permanent){
   td.append(mk('Rotate','rotate-owner','Rotate the owner key? The current key stops working immediately — Cursor and Codex will fail until you paste the new key into them.'));
  }else{
   td.append(mk(k.status==='disabled'?'Turn on':'Turn off','toggle'));
   td.append(mk('Reset','reset','Reset this key? The old value stops working immediately but is kept as a version you can revert to.'));
   td.append(mk('Delete','delete','Delete this key and its version history permanently?'));
   if(k.history?.length){
    const b=document.createElement('button');
    b.className='mini';
    b.textContent=expandedKeyId===k.id?'Hide versions':`Versions (${k.history.length})`;
    b.addEventListener('click',()=>{expandedKeyId=expandedKeyId===k.id?null:k.id;renderKeys(lastKeys);});
    td.append(b);
   }
  }
  tr.append(td);
  tbody.append(tr);
  if(expandedKeyId===k.id&&k.history?.length){
   const hr=document.createElement('tr');
   hr.className='detail-row';
   const htd=document.createElement('td');
   htd.colSpan=6;
   for(const h of k.history.slice().reverse()){
    const row=document.createElement('div');
    row.className='msg';
    const info=document.createElement('span');
    info.textContent=`v${h.v} · ${h.masked} · created ${new Date(h.createdAt).toLocaleString()} `;
    const rb=document.createElement('button');
    rb.className='mini';
    rb.textContent='Revert to this';
    rb.addEventListener('click',async()=>{
     if(!confirm(`Revert “${k.label}” to v${h.v}? The current value moves into history and this one works on the next request.`))return;
     try{const r=await window.azureBridge.keys({action:'revert',id:k.id,v:h.v});$('keys-message').textContent=r.message;}
     catch(err){$('keys-message').textContent=cleanIpcError(err,'azure:keys');}
     await refresh();
    });
    row.append(info,rb);
    htd.append(row);
   }
   hr.append(htd);
   tbody.append(hr);
  }
 }
}

function renderRequests(requests){
 lastRequests=requests||[];
 $('requests').replaceChildren();
 $('empty').hidden=lastRequests.length>0;
 for(const r of lastRequests.slice(0,12)){
  const tr=document.createElement('tr');
  tr.className='req-row'+(expandedId===r.id?' open':'');
  const source=(r.client?`${r.client} · ${r.via==='public'?'public':'local'}`:'—')+(r.key&&r.key!=='Owner'?` · key: ${r.key}`:'');
  const waited=r.queueMs>=1000?` · waited ${fmtWait(r.queueMs)} in queue`:'';
  const jumped=r.queueJumped>0?' · went ahead of a larger request':'';
  // Azure may downgrade fast requests to standard (ramp limits, peak load).
  const tier=r.tierServed==='priority'?' · ⚡ fast':r.tierRequested==='priority'?(r.tierServed?' · fast requested, Azure served standard':' · ⚡ fast requested'):'';
  for(const value of [new Date(r.at).toLocaleTimeString(),source,r.model+' / '+(r.effort||'default'),(r.error||r.status)+tier+waited+jumped,tokensCell(r)]){
   const td=document.createElement('td');
   td.textContent=value;
   tr.append(td);
  }
  tr.children[3].className=r.status==='failed'?'failed':r.status==='queued'?'warn':'ok';
  tr.addEventListener('click',()=>toggleDetail(r.id));
  $('requests').append(tr);
  if(expandedId===r.id)$('requests').append(buildDetailRow(r.id));
 }
}
const lifecycleButtons=()=>[...document.querySelectorAll('[data-action="toggle"],[data-action="restart"]')];

function setLifecycleDisabled(disabled){
 for(const button of lifecycleButtons())button.disabled=disabled;
}

function setToggleState({running,busy}){
 const button=$('bridge-toggle');
 const pending=Boolean(busy)||actionPending;
 const stopping=busy==='stop';
 const on=stopping||running;
 button.classList.toggle('is-on',on);
 button.classList.toggle('is-busy',pending);
 button.setAttribute('aria-checked',String(on));
 button.dataset.nextAction=on?'stop':'start';
 const label=pending?(stopping?'Stopping':'Starting'):(on?'Stop':'Start');
 button.querySelector('.toggle-label').textContent=label;
 button.setAttribute('aria-label',`${label} bridge`);
}

function renderCodexSwitch(codex, models){
 const button=$('codex-toggle');
 const on=Boolean(codex?.enabled);
 button.classList.toggle('is-on',on);
 button.classList.toggle('is-busy',codexPending);
 button.setAttribute('aria-checked',String(on));
 button.disabled=codexPending||Boolean(codex?.error)||(Boolean(codex?.managed)&&!on);
 button.querySelector('.toggle-label').textContent=codexPending?'Switching…':on?'On':'Off';
 $('codex-mode').textContent=codex?.error?`Codex settings unavailable: ${codex.error}`:codex?.managed&&!on?'Codex settings changed outside the bridge; resolve the conflict before switching':on?'Using Azure Cursor Bridge':'Using your OpenAI models';
 $('codex-model-list').textContent=`Bridge models: ${(models||[]).map(m=>m.label||m.id).join(' · ')}. Choose reasoning effort in Codex.`;
}

async function refresh(){
 try{
  const s=await window.azureBridge.snapshot();
  bridgeRunning=s.running;
  renderModelCards(s.models,s.settings);
  renderCodexSwitch(s.codex,s.models);
  if(!codexPending&&s.codexRestart?.startsWith('Codex restart failed:'))$('codex-message').textContent=s.codexRestart;
  if(s.chatgpt){
   $('chatgpt-status').textContent=s.chatgpt.installed?(s.chatgpt.loggedIn?(s.chatgpt.account?.method==='api-key'?'Found · signed in with an API key — sign in with ChatGPT to use plan models':'Found · signed in with ChatGPT'):'Found · NOT signed in — ChatGPT plan models will fail until you log in'):'Codex CLI not found — install the Codex app';
   renderAccountPanel('chatgpt',s.chatgpt);
  }
  if(s.claudeCli){
   $('claude-cli-status').textContent=s.claudeCli.installed?(s.claudeCli.loggedIn?'Installed · logged in':'Installed · NOT logged in — Claude CLI models will fail until you log in'):'Not installed';
   renderAccountPanel('claude',s.claudeCli);
  }
  if(s.busy)$('status').textContent=s.busy==='restart'?'Restarting bridge…':s.busy==='stop'?'Stopping bridge…':'Starting bridge…';
  else $('status').textContent=s.running?'Bridge running':'Bridge stopped';
  $('status').className='status'+(s.running?' on':'');
  setLifecycleDisabled(Boolean(s.busy)||actionPending);
  setToggleState(s);
  const off=s.mode==='off';
  $('url').textContent=off?(s.localUrl||'—'):(s.baseUrl||'Start the bridge to create an endpoint');
  $('url-note').textContent=off?'The public URL is off (Settings → Public URL). This local URL works for Codex and OpenCode on this computer; Cursor needs a public URL.'
   :s.mode==='named'?'This is a permanent URL — it stays the same across restarts and reboots. Use it as the OpenAI base URL override in Cursor and the provider base URL in Codex. Keep this computer on while using the bridge.'
   :s.baseUrl?`This is a temporary public URL — it changes each time the bridge starts. Set up your own Cloudflare tunnel in Settings for a permanent one.${s.tunnelNote?` ${s.tunnelNote}`:''}`
   :'Use this as the OpenAI base URL override in Cursor and the provider base URL in Codex. Keep this computer on while using the bridge.';
  $('detail-public').textContent=s.baseUrl||(off?'Off':'Tunnel not running');
  $('detail-local').textContent=s.localUrl||'—';
  $('detail-tunnel').textContent=off?'Off — local only':s.baseUrl?(s.mode==='named'?`Your Cloudflare tunnel “${s.tunnelName||'azure-cursor-bridge'}” — permanent URL`:'Temporary public URL — changes on restart'):'—';
  if(!actionPending&&s.running&&s.tunnel?.ok===false)$('message').textContent=`Bridge is running locally. Public URL failed: ${s.tunnel.error}`;
  renderSettings(s);
  pricingCfg=s.pricing;
  lastModels=s.models||[];
  renderPricingForm(lastModels,s.pricing);
  renderCustomModels(lastModels);
  renderPlayModels(lastModels);
  if(s.pricingIsDefault&&!$('price-message').textContent)$('price-message').textContent='Prefilled with Azure short-context list prices (Global Standard, Sep 2026). Long-context requests can cost more; verify against your agreement before saving.';
  renderAzureKey(s.azureKey);
  maybeShowWizard(s.azureKey);
  docSnippets(s.baseUrl);
  renderUsage(s.usageTotals);
  renderUsageDays(s.usageDays);
  renderQueue(s.queueLive,s.models);
  renderQueueStats(s.queueStats);
  renderRequests(s.requests);
  renderKeys(s.apiKeys);
 }catch(error){
  $('message').textContent=error.message;
 }
}

document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',async()=>{
 actionPending=true;
 setLifecycleDisabled(true);
 const action=button.dataset.action==='toggle'?button.dataset.nextAction:button.dataset.action;
 setToggleState({running:action==='stop'||bridgeRunning,busy:action});
 try{
  $('message').textContent=action==='restart'?'Restarting bridge…':action==='stop'?'Stopping bridge…':'Starting bridge…';
  $('message').textContent=await window.azureBridge.action(action);
 }catch(error){
  $('message').textContent=error.message;
 }finally{
  actionPending=false;
  await refresh();
 }
}));

// ── Settings page ──
// Form fields are filled from the bridge until the user edits them, so the
// 2.5 s refresh never overwrites what is being typed.
const editing=new Set();
document.querySelectorAll('[data-page="settings"] input,[data-page="settings"] select').forEach(el=>{
 if(el.name==='data-part')return;
 el.addEventListener('input',()=>editing.add(el.id||el.name));
 el.addEventListener('change',()=>editing.add(el.id||el.name));
});
const fill=(id,value)=>{if(!editing.has(id))$(id).value=value;};
const fmtBytes=n=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.max(1,Math.round(n/1024))} KB`;
const TUNNEL_LABELS={auto:'Automatic',named:'My Cloudflare tunnel',quick:'Temporary public URL',off:'Off'};
let analyzerSig='',bloatModelSig='';
function renderSettings(s){
 const a=s.appSettings||{},t=s.tunnelConfig||{},sys=s.system||{},d=s.data||{};
 if(!editing.has('tunnel-mode'))document.querySelectorAll('input[name="tunnel-mode"]').forEach(r=>{r.checked=r.value===(a.tunnelMode||'auto');});
 $('tunnel-now').textContent=s.mode==='off'?'Off — local only':s.baseUrl?`${s.mode==='named'?'Your tunnel':'Temporary URL'} · ${s.baseUrl}`:(s.running?'Not connected':'Bridge stopped')+(s.tunnel?.error?` · ${s.tunnel.error}`:'');
 fill('tunnel-hostname',t.hostname||'');
 $('tunnel-token-state').value=t.hasToken?'Saved (encrypted)':'None';
 if(!editing.has('tunnel-fallback'))$('tunnel-fallback').checked=a.tunnelFallback!==false;
 $('tunnel-remove').disabled=!t.hostname&&!t.hasToken;
 const port=(s.localUrl.match(/:(\d+)\//)||[])[1]||'17834';
 $('tunnel-service').textContent=`localhost:${port}`;
 $('sys-version').textContent=`${sys.version||'—'} · ${({win32:'Windows',darwin:'macOS',linux:'Linux'})[sys.platform]||sys.platform||''}`;
 fill('srv-port',port);
 $('srv-login-wrap').hidden=!sys.loginItemSupported;
 if(!editing.has('srv-login'))$('srv-login').checked=Boolean(sys.openAtLogin);
 const tool=(c,custom)=>c?.found?`${c.path}${c.custom?' (set in Settings)':' (found automatically)'}`:custom?`Not found at ${custom}`:'Not found — install it to use these models';
 $('tool-claude').textContent=tool(sys.claudeCli,a.claudeCliPath);
 $('tool-codex').textContent=tool(sys.codexCli,a.codexCliPath);
 fill('set-claude-path',a.claudeCliPath||'');
 fill('set-codex-path',a.codexCliPath||'');
 const sig=JSON.stringify((s.models||[]).map(m=>m.id));
 if(sig!==analyzerSig&&!editing.has('set-analyzer')){
  analyzerSig=sig;
  const sel=$('set-analyzer');
  sel.replaceChildren(...(s.models||[]).map(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=`${m.label||m.id} (${m.id})`;return o;}));
 }
 if(!editing.has('set-analyzer'))$('set-analyzer').value=a.analyzerModel||'azure-astra';
 if(!editing.has('bloat-level'))document.querySelectorAll('input[name="bloat-level"]').forEach(r=>{r.checked=r.value===(a.bloatLevel||'off');});
 if(sig!==bloatModelSig&&!editing.has('set-bloat-model')){
  bloatModelSig=sig;
  $('set-bloat-model').replaceChildren(...(s.models||[]).map(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=`${m.label||m.id} (${m.id})`;return o;}));
 }
 if(!editing.has('set-bloat-model'))$('set-bloat-model').value=a.bloatModel||'bridge-claude-haiku';
 $('data-file').textContent=d.file||'—';
 $('data-size').textContent=d.bytes?fmtBytes(d.bytes):'—';
 $('data-counts').textContent=`${(d.requests||0).toLocaleString()} requests · ${(d.breakdowns||0).toLocaleString()} breakdowns · ${(d.usageDays||0).toLocaleString()} days of usage · ${(d.guestKeys||0).toLocaleString()} guest keys`;
 fill('set-history',a.requestHistoryLimit||500);
 fill('set-breakdowns',a.breakdownLimit||60);
}
async function settingsCall(messageId,buttons,fn,clearIds){
 buttons.forEach(b=>{$(b).disabled=true;});
 $(messageId).textContent='Working…';
 try{const r=await fn();$(messageId).textContent=r.message;(clearIds||[]).forEach(id=>editing.delete(id));}
 catch(err){$(messageId).textContent=String(err?.message||err).replace(/^Error invoking remote method '[^']+': (Error: )?/,'');}
 finally{buttons.forEach(b=>{$(b).disabled=false;});await refresh();}
}
$('tunnel-save').addEventListener('click',()=>{
 const mode=document.querySelector('input[name="tunnel-mode"]:checked')?.value||'auto';
 if(mode==='off'&&!confirm('Turn the public URL off? Cursor will not be able to reach the bridge until you turn it back on.'))return;
 settingsCall('tunnel-message',['tunnel-save','tunnel-reconnect','tunnel-remove'],async()=>{
  const r=await window.azureBridge.tunnel({action:'save',mode,hostname:$('tunnel-hostname').value,token:$('tunnel-token').value,fallback:$('tunnel-fallback').checked});
  $('tunnel-token').value='';
  return r;
 },['tunnel-mode','tunnel-hostname','tunnel-token','tunnel-fallback']);
});
$('tunnel-reconnect').addEventListener('click',()=>settingsCall('tunnel-message',['tunnel-save','tunnel-reconnect','tunnel-remove'],()=>window.azureBridge.tunnel({action:'reconnect'})));
$('tunnel-remove').addEventListener('click',()=>{
 if(!confirm('Remove your Cloudflare tunnel hostname and token from this bridge? The bridge switches to a temporary public URL. The tunnel itself stays in your Cloudflare account.'))return;
 settingsCall('tunnel-message',['tunnel-save','tunnel-reconnect','tunnel-remove'],()=>window.azureBridge.tunnel({action:'remove'}),['tunnel-mode','tunnel-hostname','tunnel-token']);
});
$('srv-port-save').addEventListener('click',()=>{
 const port=Number($('srv-port').value);
 if(!confirm(`Move the bridge to port ${port}? It restarts now, interrupting requests in progress.`))return;
 settingsCall('srv-message',['srv-port-save'],()=>window.azureBridge.server({action:'port',port}),['srv-port']);
});
$('srv-login').addEventListener('change',()=>settingsCall('srv-message',[],()=>window.azureBridge.server({action:'login-item',enabled:$('srv-login').checked}),['srv-login']));
$('tools-save').addEventListener('click',()=>settingsCall('tools-message',['tools-save'],()=>window.azureBridge.appSettings({claudeCliPath:$('set-claude-path').value,codexCliPath:$('set-codex-path').value,analyzerModel:$('set-analyzer').value}),['set-claude-path','set-codex-path','set-analyzer']));
$('bloat-save').addEventListener('click',()=>settingsCall('bloat-message',['bloat-save'],()=>{
 const patch={bloatLevel:document.querySelector('input[name="bloat-level"]:checked')?.value||'off'};
 if($('set-bloat-model').value)patch.bloatModel=$('set-bloat-model').value;
 return window.azureBridge.appSettings(patch);
},['bloat-level','set-bloat-model']));
$('history-save').addEventListener('click',()=>settingsCall('data-message',['history-save'],()=>window.azureBridge.appSettings({requestHistoryLimit:Number($('set-history').value),breakdownLimit:Number($('set-breakdowns').value)}),['set-history','set-breakdowns']));
$('data-open').addEventListener('click',()=>settingsCall('data-message',[],()=>window.azureBridge.data({action:'open-folder'})));
$('data-compact').addEventListener('click',()=>settingsCall('data-message',['data-compact'],()=>window.azureBridge.data({action:'compact'})));
$('data-select-all').addEventListener('click',()=>{
 const boxes=[...document.querySelectorAll('input[name="data-part"]')];
 const all=boxes.every(b=>b.checked);
 boxes.forEach(b=>{b.checked=!all;});
 $('data-select-all').textContent=all?'Select everything':'Select none';
});
$('data-clear').addEventListener('click',()=>{
 const boxes=[...document.querySelectorAll('input[name="data-part"]:checked')];
 if(!boxes.length){$('data-message').textContent='Choose what to clear first.';return;}
 const list=boxes.map(b=>`• ${b.parentElement.textContent.trim()}`).join('\n');
 if(!confirm(`Clear these from this computer? This cannot be undone.\n\n${list}`))return;
 settingsCall('data-message',['data-clear'],async()=>{
  const r=await window.azureBridge.data({action:'clear',parts:boxes.map(b=>b.value)});
  document.querySelectorAll('input[name="data-part"]').forEach(b=>{b.checked=false;});
  $('data-select-all').textContent='Select everything';
  return r;
 },[...editing]);
});

window.azureBridge.onLifecycleError(message=>{
 $('message').textContent=`Automatic start failed: ${message}`;
});

refresh();
setInterval(refresh,2500);

$('codex-toggle').addEventListener('click',async()=>{
 const enabled=$('codex-toggle').getAttribute('aria-checked')!=='true';
 if(!confirm(`Switch Codex to ${enabled?'the Azure Cursor Bridge':'your previous OpenAI setup'}? Codex will restart and any running tasks will stop.`))return;
 codexPending=true;
 $('codex-message').textContent='Saving Codex settings and restarting the desktop app…';
 try{
  const result=await window.azureBridge.codexSwitch(enabled);
  $('codex-message').textContent=result.message;
 }catch(error){$('codex-message').textContent=cleanIpcError(error,'azure:codex-switch');}
 finally{codexPending=false;await refresh();}
});

$('price-save').addEventListener('click',async()=>{
 const button=$('price-save');
 button.disabled=true;
 try{
  const payload={};
  for(const m of lastModels){
   payload[m.id]={};
   for(const f of ['input','cachedInput','output']){
    const el=$(`price-${m.id}-${f}`);
    payload[m.id][f]=el&&el.value!==''?Number(el.value):0;
   }
   const fm=$(`price-${m.id}-fastMultiplier`);
   if(fm&&fm.value!=='')payload[m.id].fastMultiplier=Number(fm.value);
  }
  pricingCfg=await window.azureBridge.savePricing(payload);
  $('price-message').textContent='Rates saved — estimates update immediately.';
 }catch(err){
  $('price-message').textContent=cleanIpcError(err,'azure:pricing');
 }finally{
  button.disabled=false;
  await refresh();
 }
});

$('key-create').addEventListener('click',async()=>{
 const button=$('key-create');
 button.disabled=true;
 try{
  const r=await window.azureBridge.keys({action:'create',label:$('key-label').value.trim()||'Guest',hours:Number($('key-expiry').value)});
  $('keys-message').textContent=r.message;
  $('key-label').value='';
 }catch(err){
  $('keys-message').textContent=cleanIpcError(err,'azure:keys');
 }finally{
  button.disabled=false;
  await refresh();
 }
});

$('play-send').addEventListener('click',async()=>{
 const button=$('play-send');
 button.disabled=true;
 $('play-status').textContent='Sending… this can take a while at high reasoning effort.';
 $('play-status').className='';
 $('play-response').hidden=true;
 $('play-meta').textContent='';
 try{
  const result=await window.azureBridge.test({model:$('play-model').value,target:$('play-target').value,prompt:$('play-prompt').value});
  $('play-status').textContent='Success';
  $('play-status').className='ok';
  $('play-response').textContent=result.text||'(empty response)';
  $('play-response').hidden=false;
  const u=result.usage;
  $('play-meta').textContent=`${result.model} via ${result.base} · ${(result.durationMs/1000).toFixed(1)}s`+(u?` · ${u.prompt_tokens} tokens in / ${u.completion_tokens} tokens out`:'');
 }catch(error){
  $('play-status').textContent='Failed';
  $('play-status').className='failed';
  $('play-response').textContent=String(error.message||error).replace(/^Error invoking remote method 'azure:test': (Error: )?/,'');
  $('play-response').hidden=false;
 }finally{
  button.disabled=false;
  refresh();
 }
});

