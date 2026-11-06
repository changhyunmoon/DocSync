const buttons=[...document.querySelectorAll('.desktop-download')];
const progress=document.querySelector('#download-progress');
for(const button of buttons)button.addEventListener('click',downloadInstaller);
async function downloadInstaller(){
  buttons.forEach(button=>button.disabled=true);
  progress.textContent='설치 파일을 준비하고 있습니다…';
  try{
    const response=await fetch('./download/manifest.json');
    if(!response.ok)throw Error('다운로드 정보를 찾을 수 없습니다.');
    const manifest=await response.json();
    const chunks=[];let loaded=0;
    for(const part of manifest.parts){
      const res=await fetch(`./download/${part.name}`);
      if(!res.ok)throw Error('설치 파일을 내려받지 못했습니다.');
      const blob=await res.blob();
      if(blob.size!==part.size)throw Error('설치 파일의 크기가 올바르지 않습니다.');
      chunks.push(blob);loaded+=blob.size;
      progress.textContent=`다운로드 준비 중 · ${Math.round(loaded/manifest.size*100)}%`;
    }
    const file=new Blob(chunks,{type:'application/octet-stream'});
    const url=URL.createObjectURL(file);
    const a=document.createElement('a');a.href=url;a.download=manifest.filename;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),120000);
    progress.textContent='다운로드가 시작되었습니다.';
  }catch(error){progress.textContent=`다운로드 실패: ${error.message}`;}
  finally{buttons.forEach(button=>button.disabled=false);}
}
