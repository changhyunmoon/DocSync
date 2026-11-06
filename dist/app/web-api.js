// Browser implementation of the desktop app's test-mode IPC contract.
// It uses the same sample files and mock decisions, while keeping writes in memory.
(() => {
  const stateListeners = new Set();
  const fsListeners = new Set();
  const toastListeners = new Set();
  const state = {root:'/MarketFlow-샘플-1',rootName:'MarketFlow-샘플-1',scope:['docs'],sources:[],items:[],messages:[],processing:false,processingLabel:'',key:null,savedKeys:[],keyPersist:false,testMode:true};
  const records = new Map();
  let seed, files, seq=0, itemNo=0, sampleNo=1, order=0, abort=false;
  const ready=fetch('../demo-data.json').then(r=>{if(!r.ok)throw Error('샘플 데이터를 불러올 수 없습니다.');return r.json()}).then(d=>{seed=d;files=structuredClone(d.files);return d});
  const ok=(message)=>({ok:true,...(message?{message}:{})});
  const fail=(message)=>({ok:false,message});
  const id=(prefix)=>`${prefix}${++seq}`;
  const snapshot=()=>structuredClone(state);
  const changed=()=>{const s=snapshot();stateListeners.forEach(fn=>fn(s))};
  const fsChanged=()=>fsListeners.forEach(fn=>fn());
  const toast=(text)=>toastListeners.forEach(fn=>fn(text));
  const item=(id)=>state.items.find(x=>x.id===id);
  const map=(it,id)=>it?.mappings.find(x=>x.id===id);
  const count=(text,needle)=>needle?text.split(needle).length-1:0;
  const inScope=(p)=>!state.scope.length||state.scope.some(s=>p===s||p.startsWith(s+'/'));
  const isChange=(m)=>!!m.file&&m.relation!=='중복'&&m.relation!=='판단 필요'&&(!!m.moveTo||m.oldText!==m.newText);
  // 파일별 결정: 기존 유지 · 제안 채택 · 보류 (desktop/src/shared/review.ts와 같은 규칙)
  const isActive=(m)=>isChange(m)&&!m.rejected&&!m.held;
  const sig=(m)=>JSON.stringify([m.file,m.moveTo??null,m.oldText,m.newText]);
  const review=(m)=>m.rejected?'kept':m.held?'held':m.approvedSig===sig(m)?'adopted':'pending';
  function syncStatus(it){
    const r=it.mappings.filter(isChange).map(review);const n=(k)=>r.filter(x=>x===k).length;const was=it.status;
    if(n('pending')){if(was!=='rereview')it.status='pending';return was==='approved'?'검토 전 파일이 생겨 반영 대기가 풀렸습니다.':undefined;}
    it.rereviewReason=undefined;
    if(n('adopted')){it.status='approved';return was==='approved'?undefined:`모든 파일을 검토했습니다. 반영하면 채택한 파일 ${n('adopted')}개가 수정됩니다.`;}
    it.status=n('held')?'held':'rejected';
    return n('held')?'채택한 파일 없이 보류한 파일이 있어 항목을 보류했습니다.':'모든 파일을 기존 유지로 결정해 이 항목은 반영하지 않습니다.';
  }
  function tree(){const root={};for(const full of Object.keys(files)){const parts=full.split('/');let node=root;let prefix='';for(const part of parts){prefix=prefix?`${prefix}/${part}`:part;if(!node[part])node[part]={path:prefix,name:part,dir:false,children:{}};node=node[part].children;}}const walk=(object)=>Object.values(object).map(x=>x.path in files?{path:x.path,name:x.name,dir:false}:{path:x.path,name:x.name,dir:true,children:walk(x.children)});return walk(root);}
  function validate(){for(const it of state.items){if(!['pending','approved','rereview'].includes(it.status))continue;let bad=false;for(const m of it.mappings){if(!isActive(m)){m.stale=null;continue;}const current=files[m.file];let stale=null;if(m.moveTo&&files[m.moveTo]!==undefined)stale='ambiguous';else if(m.oldText&&(!current||count(current,m.oldText)===0))stale='missing';else if(m.oldText&&count(current,m.oldText)>1)stale='ambiguous';m.stale=stale;if(stale)bad=true;}if(bad){it.status='rereview';it.rereviewReason='앞선 반영이나 파일 수정으로 기준 내용이 바뀌었습니다. 변경안을 다시 계산하세요.';}else if(it.status==='rereview'&&it.rereviewReason?.startsWith('앞선 반영')){it.status='pending';it.rereviewReason=undefined;}}}
  function draftToItem(d,sources){const source=sources.find(x=>x.text.includes(d.quote))??sources[0];const start=source?.text.indexOf(d.quote)??-1;return {id:id('i'),no:++itemNo,kind:'content',title:d.title,detail:d.detail,confirmed:d.confirmed!==false,status:d.confirmed===false?'excluded':'pending',evidence:start>=0?[{sourceId:source.id,start,end:start+d.quote.length,quote:d.quote}]:[],mappings:d.mappings.map(m=>({id:id('mp'),file:m.file,section:m.section,relation:m.relation,reason:m.reason,existing:m.existing??m.oldText,oldText:m.oldText,newText:m.newText,stale:null}))};}
  // 문서에 이미 있는 내용만 있는 항목은 실제 분석처럼 '이미 존재'로 표시한다
  function markExisting(it){if(it.status!=='pending'||!it.mappings.length)return;if(it.mappings.every(m=>m.relation==='중복'&&m.file&&m.existing&&(files[m.file]??'').includes(m.existing)))it.status='confirmed';}
  function genericDrafts(material){const docs=Object.keys(files).filter(p=>/\.md$/i.test(p)&&inScope(p)&&!/(?:README|index)\.md$/i.test(p));const lines=material.split(/\n|(?<=[.!?。])\s+/).map(s=>s.trim().replace(/^[-*•\d.)\s]+/,'')).filter(s=>s.length>=12&&!s.startsWith('#')).slice(0,3);const chosen=lines.length?lines:[material.trim().slice(0,200)];return chosen.filter(Boolean).map((line,i)=>{const words=line.toLowerCase().match(/[가-힣]{2,}|[a-z]{3,}/g)??[];const scored=docs.map(file=>({file,score:words.reduce((n,w)=>n+(file.toLowerCase().includes(w)?1:0),0)})).sort((a,b)=>b.score-a.score||a.file.localeCompare(b.file));const file=scored[0]?.file??`docs/test-note-${i+1}.md`;const title=line.replace(/[.!?。]$/,'').slice(0,32);return {title,detail:line,quote:line,mappings:[{file,section:files[file]!==undefined?'문서 끝에 추가':'새 예시 문서',oldText:'',newText:`${files[file]!==undefined?'\n':''}## ${title}\n${line}\n`,relation:'신규',reason:files[file]!==undefined?'입력 문구와 경로 이름이 가까운 문서에 예시 문구를 추가합니다.':'반영 범위에 Markdown 문서가 없어 예시 문서를 만듭니다.'}]};});}
  function previewMapping(it,m){const path=m.moveTo?`${m.file} → ${m.moveTo}`:m.file??'';if(!m.file)return {mappingId:m.id,path:'',original:'',modified:'',valid:true};const current=files[m.file]??'';if(it.status==='applied'&&(m.rejected||m.held))return {mappingId:m.id,path,original:current,modified:current,valid:true};if(it.status==='applied'&&!m.moveTo&&isChange(m)){if(m.newText&&count(current,m.newText)===1){return {mappingId:m.id,path,original:current.replace(m.newText,m.oldText),modified:current,valid:true,appliedEdit:true};}const rec=records.get(it.id)?.find(x=>x.mappingId===m.id);if(rec)return {mappingId:m.id,path,original:rec.before??'',modified:rec.after??'',valid:true};}if(!isChange(m))return {mappingId:m.id,path,original:current,modified:current,valid:true};if(m.moveTo)return {mappingId:m.id,path,original:current,modified:m.newText,valid:files[m.moveTo]===undefined,problem:files[m.moveTo]!==undefined?'이동할 경로에 파일이 이미 있습니다.':undefined};if(m.oldText===''){const modified=current?`${current}${current.endsWith('\n')?'':'\n'}${m.newText}`:m.newText;return {mappingId:m.id,path,original:current,modified,valid:true};}const n=count(current,m.oldText);return {mappingId:m.id,path,original:current,modified:n===1?current.replace(m.oldText,m.newText):current,valid:n===1,problem:n===0?'현재 파일에서 기준 문구를 찾을 수 없습니다.':'기준 문구가 여러 곳에 있습니다.'};}
  async function send(input){await ready;const text=input.text.trim();if(!text&&!input.attachments.length)return {ok:false};const sources=input.attachments.map(a=>({id:id('s'),name:a.name,text:a.text}));if(text)sources.push({id:id('s'),name:input.attachments.length?'요청 내용':'입력 자료',text});state.sources.push(...sources);state.messages.push({id:id('m'),role:'user',text:text||'자료를 첨부했습니다.',attachments:sources.map(s=>({sourceId:s.id,name:s.name}))});state.processing=true;state.processingLabel='테스트 변경안 만드는 중';changed();abort=false;await new Promise(resolve=>setTimeout(resolve,450));if(abort){state.processing=false;state.processingLabel='';changed();return fail('중지했습니다.');}const material=sources.map(s=>s.text).join('\n');const sample=material.includes('MarketFlow 회원가입 전환 및 인증 운영안 회의록');const candidates=sample?structuredClone(seed.items):[];const readySample=candidates.length&&candidates.every(d=>d.mappings.every(m=>!m.file||(m.relation==='중복'?(files[m.file]??'').includes(m.existing??''):!m.oldText?files[m.file]===undefined:(files[m.file]??'').includes(m.oldText))));const drafts=readySample?candidates:genericDrafts(material);for(const d of drafts){const it=draftToItem(d,sources);markExisting(it);state.items.push(it);}validate();state.messages.push({id:id('m'),role:'ai',mock:true,text:`회의록에서 ${drafts.length}개 항목을 정리했습니다. 결정된 내용은 문서별 변경안(신규·보완·충돌)에 연결했고, 문서에 이미 있는 내용은 "이미 존재"로, 알맞은 문서를 찾지 못한 부분은 "판단 필요"로, 미결 사항은 "미확정"으로 표시했습니다. 항목을 열어 파일마다 diff를 확인해 기존 유지·제안 채택·보류를 고른 뒤 반영해 보세요.\n\n테스트 모드의 예시 결과이며 AI가 분석한 내용은 아닙니다.`});state.processing=false;state.processingLabel='';changed();return ok();}
  function applyOne(it){
    const staged={...files},ops=[];
    for(const m of it.mappings){
      if(!isActive(m))continue;
      if(!inScope(m.file))return fail(`반영 범위 밖 파일입니다: ${m.file}`);
      const current=staged[m.file]??null;
      let after;
      if(m.moveTo){
        if(current===null)return fail(`${m.file}: 이동할 파일이 없습니다.`);
        if(staged[m.moveTo]!==undefined)return fail(`${m.moveTo}: 이미 파일이 있습니다.`);
        if(m.oldText&&count(current,m.oldText)!==1)return fail(`${m.file}: 기준 내용이 바뀌었습니다.`);
        after=m.oldText?current.replace(m.oldText,m.newText):m.newText;
        delete staged[m.file];staged[m.moveTo]=after;
      }else if(m.oldText===''){
        after=current===null?m.newText:`${current}${current.endsWith('\n')?'':'\n'}${m.newText}`;
        staged[m.file]=after;
      }else{
        if(current===null||count(current,m.oldText)!==1)return fail(`${m.file}: 기준 내용이 바뀌었습니다.`);
        after=current.replace(m.oldText,m.newText);
        staged[m.file]=after;
      }
      ops.push({mappingId:m.id,path:m.file,moveTo:m.moveTo,before:current,after});
    }
    files=staged;records.set(it.id,ops);it.status='applied';it.appliedOrder=++order;it.rereviewReason=undefined;
    return ok();
  }
  function undoOne(it){const ops=records.get(it.id);if(!ops)return fail('되돌리기 정보가 없습니다.');for(const op of ops){const p=op.moveTo??op.path;const current=files[p];const m=it.mappings.find(x=>x.id===op.mappingId);if(current===undefined||!m)return fail(`${p}: 되돌릴 수 없습니다.`);if(!op.moveTo&&m.newText&&count(current,m.newText)!==1)return fail(`${p}: 반영 구간이 바뀌어 되돌릴 수 없습니다.`);}for(const op of [...ops].reverse()){const m=it.mappings.find(x=>x.id===op.mappingId);if(op.moveTo){delete files[op.moveTo];if(op.before!==null)files[op.path]=op.before;}else if(op.before===null)delete files[op.path];else if(m.newText)files[op.path]=files[op.path].replace(m.newText,m.oldText);else files[op.path]=op.before;}records.delete(it.id);it.status='approved';it.appliedOrder=undefined;validate();changed();fsChanged();return ok(`#${it.no} 반영을 되돌렸습니다. 반영 대기 상태로 돌아갑니다.`);}
  const api={
    async getState(){await ready;return snapshot()},
    onState(cb){stateListeners.add(cb);return()=>stateListeners.delete(cb)},
    onFsChanged(cb){fsListeners.add(cb);return()=>fsListeners.delete(cb)},
    onToast(cb){toastListeners.add(cb);return()=>toastListeners.delete(cb)},
    async openDemoProject(){await ready;sampleNo++;files=structuredClone(seed.files);state.root=`/MarketFlow-샘플-${sampleNo}`;state.rootName=`MarketFlow-샘플-${sampleNo}`;state.scope=['docs'];state.sources=[];state.items=[];state.messages=[];records.clear();itemNo=0;order=0;changed();fsChanged();return snapshot()},
    async openProject(){return snapshot()},
    async setTestMode(enabled){return enabled?ok():fail('웹 데모에서는 샘플 프로젝트만 사용할 수 있습니다. 실제 프로젝트는 데스크톱 앱에서 여세요.')},
    async tree(){await ready;return tree()},
    async readFile(p){await ready;return files[p]??null},
    async writeFile(p,content,base){await ready;if(typeof base==='string'&&files[p]!==base)return {ok:false,conflict:true,message:`${p}: 편집하는 동안 파일이 바뀌었습니다.`};files[p]=content;validate();changed();fsChanged();return ok(`${p} 저장됨`)},
    async createEntry(p,dir){await ready;p=p.replace(/\\/g,'/').replace(/^\/?/,'');if(!p||p.includes('..'))return fail('올바른 경로를 입력하세요.');if(files[p]!==undefined)return fail('같은 이름이 이미 있습니다.');if(!dir)files[p]='';changed();fsChanged();return ok()},
    async deleteEntry(p){await ready;for(const file of Object.keys(files))if(file===p||file.startsWith(p+'/'))delete files[file];validate();changed();fsChanged();return ok(`${p} 삭제됨`)},
    async toggleScope(p){state.scope=state.scope.includes(p)?state.scope.filter(x=>x!==p):[...state.scope.filter(x=>!x.startsWith(p+'/')),p];changed();return ok(state.scope.length?`반영 범위: ${state.scope.join(', ')}`:'반영 범위: 프로젝트 전체')},
    async setKey(){return fail('웹 데모에서는 API 키를 사용하지 않습니다.')},async setModel(){return fail('웹 데모에서는 API 키를 사용하지 않습니다.')},async clearKey(){return ok()},async useSavedKey(){return fail('웹 데모에서는 API 키를 사용하지 않습니다.')},
    async pickAttachments(){return new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.accept='.md,.txt,text/plain,text/markdown';input.multiple=true;input.onchange=async()=>resolve(await Promise.all([...input.files].map(async f=>({name:f.name,text:await f.text()}))));input.oncancel=()=>resolve([]);input.click()})},
    send,
    async stop(){abort=true;return ok()},
    async clearConversation(){if(state.processing)return fail('처리가 끝난 뒤 대화를 지우세요.');if(!window.confirm('대화와 현재 작업을 모두 지울까요? 이미 반영한 문서는 그대로 남습니다.'))return {ok:false};state.sources=[];state.items=[];state.messages=[];records.clear();itemNo=0;order=0;changed();return ok('대화와 현재 작업을 지웠습니다.')},
    async itemAction(itemId,action){const it=item(itemId);if(!it)return {ok:false};if(action==='undo')return undoOne(it);if(['approve','adopt'].includes(action)){validate();if(it.status==='rereview'&&it.mappings.some(m=>isActive(m)&&m.stale))return fail('기준 내용이 바뀌어 채택할 수 없습니다. 변경안을 다시 계산하세요.');if(!it.mappings.some(isChange))return fail('파일 변경이 없는 항목입니다.');if(!it.mappings.some(isActive))return fail('모든 파일을 기존 유지·보류로 결정한 항목입니다. 채택할 파일의 결정을 먼저 바꾸세요.');for(const m of it.mappings)if(isActive(m))m.approvedSig=sig(m);const msg=syncStatus(it);changed();return ok(msg);}else if(action==='reject'||action==='keep')it.status='rejected';else if(action==='hold')it.status='held';else if(['unapprove','restore','include'].includes(action)){for(const m of it.mappings){m.approvedSig=undefined;if(action==='restore'){m.rejected=undefined;m.held=undefined;}}it.status='pending';it.rereviewReason=undefined;validate();}else if(action==='confirmDup')it.status='confirmed';else return fail('지원하지 않는 동작입니다.');changed();return ok()},
    async fileAction(itemId,mappingId,action){const it=item(itemId),m=map(it,mappingId);if(!m)return {ok:false};if(!isChange(m))return fail('파일 변경이 없는 매핑입니다.');if(!['pending','approved','rereview','rejected','held'].includes(it.status))return fail('반영 전인 항목에서만 파일별로 결정할 수 있습니다.');if(action==='adopt'){const cur=files[m.file];const stale=(m.moveTo&&files[m.moveTo]!==undefined)||(m.oldText&&(!cur||count(cur,m.oldText)!==1));if(stale)return fail(`${m.file}: 변경 기준 내용을 현재 파일에서 찾을 수 없습니다. 변경안을 다시 계산하거나 기존 유지·보류를 선택하세요.`);const outside=[m.file,m.moveTo].filter(p=>p&&!inScope(p));if(it.kind==='content'&&outside.length)return fail(`반영 범위 밖 파일이라 채택할 수 없습니다: ${outside.join(', ')} · 기존 유지나 보류를 선택하세요.`);m.rejected=undefined;m.held=undefined;m.approvedSig=sig(m);}else if(action==='keep'||action==='hold'){m.rejected=action==='keep'?true:undefined;m.held=action==='hold'?true:undefined;m.approvedSig=undefined;}else if(action==='reset'){m.rejected=undefined;m.held=undefined;m.approvedSig=undefined;}else return {ok:false};validate();if(it.status==='rereview'&&it.rereviewReason?.startsWith('반영 범위 밖')&&!it.mappings.some(x=>isActive(x)&&!inScope(x.file))){it.status='pending';it.rereviewReason=undefined;}const msg=it.mappings.some(x=>isActive(x)&&x.stale)?undefined:syncStatus(it);changed();return ok(msg)},
    async applyItems(ids){let done=0;const fails=[];for(const itemId of ids){const it=item(itemId);if(!it||it.status!=='approved')continue;const r=applyOne(it);if(r.ok)done++;else{it.status='rereview';it.rereviewReason=r.message;fails.push(`#${it.no}`);}validate();}changed();if(done)fsChanged();if(!done&&!fails.length)return fail('반영 대기 항목이 없습니다.');return {ok:fails.length===0,message:`${done}개 항목을 파일에 반영했습니다${fails.length?` · 실패 ${fails.join(', ')}`:''}`}},
    async applyAllApproved(){return api.applyItems(state.items.filter(x=>x.status==='approved').sort((a,b)=>a.no-b.no).map(x=>x.id))},
    async regenerate(itemId,instruction){const it=item(itemId);if(!it)return {ok:false};if(it.status==='applied')return fail('반영된 항목은 되돌린 뒤 다시 계산하세요.');if(instruction?.trim()){it.detail=instruction.trim();for(const m of it.mappings)m.newText=m.oldText?`${m.oldText}\n${instruction.trim()}`:`\n## ${it.title}\n${instruction.trim()}\n`;}it.status='pending';it.rereviewReason=undefined;validate();changed();return ok('테스트 변경안을 현재 문서 기준으로 갱신했습니다.')},
    async editMapping(itemId,mappingId,newText){const it=item(itemId),m=map(it,mappingId);if(!m)return {ok:false};if(it.status==='applied'){const current=files[m.file];if(!current||count(current,m.newText)!==1)return fail('반영한 구간을 찾을 수 없습니다.');files[m.file]=current.replace(m.newText,newText);m.newText=newText;validate();changed();fsChanged();return ok();}if(!['pending','approved','rereview','excluded','held'].includes(it.status))return fail('이 항목은 편집할 수 없습니다.');m.newText=newText;if(it.status==='approved')it.status='pending';changed();return ok(it.status==='pending'?'내용이 바뀌어 이 파일의 채택이 풀렸습니다. 다시 채택하세요.':undefined)},
    async setMappingFile(itemId,mappingId,file){const it=item(itemId),m=map(it,mappingId);if(!m)return {ok:false};m.file=file;if(file){const exists=files[file]!==undefined;const text=it.evidence[0]?.quote??it.detail;m.relation='신규';m.oldText='';m.newText=`${exists?"\n":""}## ${m.section||it.title}\n${text}\n`;m.reason=exists?'지정한 문서 끝에 예시 문단을 추가합니다.':'지정한 경로에 예시 문서를 새로 만듭니다.';m.approvedSig=undefined;if(it.status==='approved')it.status='pending';validate();changed();return ok(`${file} 기준으로 예시 변경안을 만들었습니다. 이 파일도 검토해 주세요.`);}changed();return file?api.regenerate(itemId,`이 항목의 대상 문서를 ${file}로 지정했습니다.`):ok()},
    async setNewFilePath(itemId,mappingId,p){const it=item(itemId),m=map(it,mappingId);if(!m||m.oldText||m.moveTo)return fail('새 문서 매핑만 위치를 바꿀 수 있습니다.');if(files[p]!==undefined)return fail('같은 경로에 이미 파일이 있습니다.');m.file=p;if(it.status==='approved')it.status='pending';changed();return ok(`새 문서 위치를 ${p}(으)로 바꿨습니다.`)},
    async proposeMove(from,to){await ready;if(files[from]===undefined)return fail('이동할 파일이 없습니다.');if(files[to]!==undefined)return fail('이동할 경로에 파일이 이미 있습니다.');const m={id:id('mp'),file:from,moveTo:to,section:'',relation:'이동',reason:'경로 변경',existing:'',oldText:files[from],newText:files[from],stale:null};const it={id:id('i'),no:++itemNo,kind:'move',title:`${from} → ${to}`,detail:'문서 경로 변경',confirmed:true,status:'pending',evidence:[],mappings:[m],notes:[]};state.items.push(it);state.messages.push({id:id('m'),role:'ai',mock:true,text:`이동 변경안 #${it.no}을 만들었습니다. 제안 채택 후 반영하세요.`});changed();return ok(`이동 변경안 #${it.no}을 만들었습니다.`)},
    async previews(itemId){await ready;const it=item(itemId);return it?it.mappings.map(m=>previewMapping(it,m)):[]}
  };
  window.api=api;
  ready.catch(error=>{console.error(error);toast('샘플 프로젝트를 불러오지 못했습니다.');});
})();
