(async function () {
 'use strict';
 const banner=document.getElementById('setupEntry'),dialog=document.getElementById('setupWelcome');if(!banner||!dialog)return;
 const text=(ru,en)=>document.documentElement.lang==='en'?en:ru;
 const get=name=>{try{return localStorage.getItem(name);}catch{return null;}},set=(name,value)=>{try{localStorage.setItem(name,value);}catch{}};
 function render(){
  document.getElementById('setupEntryTitle').textContent=text('Сначала настроим под тебя','Let’s make it yours');
  document.getElementById('setupEntryNote').textContent=text('Устройство, поведение, калибровка и Telegram — шаг за шагом.','Device, behavior, calibration and Telegram — step by step.');
  for(const id of ['setupEntryStart','setupWelcomeStart'])document.getElementById(id).textContent=text('Мастер настройки','Setup guide');
  document.getElementById('setupWelcomeTitle').textContent=text('Привет. Давай познакомимся.','Hi. Let’s get you started.');
  document.getElementById('setupWelcomeNote').textContent=text('Пройдём первую настройку вместе. Можно пропустить и вернуться к ней в настройках.','We’ll walk through the first setup together. You can skip it and return from Settings.');
  document.getElementById('setupWelcomeLater').textContent=text('Позже','Later');
  document.getElementById('setupEntryDismiss').setAttribute('aria-label',text('Закрыть','Dismiss'));
 }
 render();window.addEventListener('xlam-language-changed',render);
 if(get('xlam-setup-complete')||get('xlam-setup-dismissed'))return;
 banner.hidden=false;
 document.getElementById('setupEntryDismiss').onclick=()=>{set('xlam-setup-dismissed','1');banner.hidden=true;};
 dialog.addEventListener('close',()=>set('xlam-setup-seen','1'));
 for(const id of ['setupEntryStart','setupWelcomeStart'])document.getElementById(id).onclick=()=>set('xlam-setup-seen','1');
 if(get('xlam-setup-seen'))return;
 try{const response=await XlamSession.fetch('/api/devices');if(!response.ok)return;const data=await response.json();
  if(!(data.devices||[]).some(d=>d.runtime?.is_running||['starting','stopping','paused','pausing'].includes(d.runtime?.state)))dialog.showModal();
 }catch{}
})();
