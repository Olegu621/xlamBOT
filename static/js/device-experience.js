/* Device-specific, optional controls; safe defaults for first-time users. */
(() => {
 'use strict';
 const en=()=>document.documentElement.lang==='en';
 const text=(ru,eng)=>en()?eng:ru;
 const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const options=[['perMatch','За матч','Per match'],['streak','Серия','Streak'],['uptime','В работе','Uptime'],['gas','Газ','Gas'],['queue','Очередь','Queue'],['training','Обучение','Training'],['calibration','Калибровка','Calibration'],['pause','Пауза','Pause'],['logs','Логи','Logs']];
 const labelKeys={'За матч':'perMatch','Per match':'perMatch','Серия':'streak','Streak':'streak','В работе':'uptime','Uptime':'uptime','Running':'uptime','Газ':'gas','Gas':'gas','Очередь':'queue','Queue':'queue','Ротация':'queue','Rotation':'queue'};
 const prefs=new Map();
 function preferences(key){if(!prefs.has(key)){let saved={};try{saved=JSON.parse(localStorage.getItem('xlam-panel-layout:'+key)||'{}');}catch(_){}prefs.set(key,saved);}return prefs.get(key);}
 function mark(el,key,visible){if(!el)return;el.dataset.panelItem=key;const value=String(!visible);if(el.dataset.customHidden!==value)el.dataset.customHidden=value;}
 function apply(card){
  const pref=preferences(card.dataset.key);
  card.querySelectorAll('.stat-box').forEach(box=>{const label=box.querySelector('.stat-box-label');const key=labelKeys[label?.textContent.trim()];if(key){if(key==='queue'&&['Ротация','Rotation'].includes(label.textContent.trim()))label.textContent=text('Очередь','Queue');mark(box,key,pref[key]===true);}});
  mark(card.querySelector('[data-action="pause"], [data-action="resume"]'),'pause',pref.pause===true||!!card.querySelector('[data-action="resume"]'));
  mark(card.querySelector('.gas-box'),'gas',pref.gas===true);
  mark(card.querySelector('.preview-gas'),'gas',pref.gas===true);
  mark(card.querySelector('[data-action="training"]'),'training',pref.training===true);
  mark(card.querySelector('.training-row'),'training',pref.training===true||!!card.querySelector('.training-row.is-recording'));
  const calibration=card.querySelector('a[href^="/calibration/"]');
  if(calibration){const title=text('Калибровка','Calibration');if(calibration.textContent!==title)calibration.textContent=title;mark(calibration,'calibration',pref.calibration===true);}
  mark(card.querySelector('[data-details]'),'logs',pref.logs===true);
  mark(card.querySelector('.rotate-bar'),'queue',pref.queue===true);
  // Long diagnostic explanations remain available through the logs switch.
  mark(card.querySelector('.live-diagnostics'),'logs',pref.logs===true);
 }
 function editor(card){
  if(card.querySelector('.panel-customizer'))return;
  const key=card.dataset.key;const wrapper=document.createElement('details');wrapper.className='panel-customizer flyout';
  wrapper.innerHTML=`<summary class="btn btn-ghost pencil-button" title="${text('Изменить панель','Customize panel')}" aria-label="${text('Изменить панель','Customize panel')}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></summary><div class="flyout-body"><div class="flyout-title">${text('Твоя панель','Your panel')}</div><p>${text('Оставь только то, чем пользуешься.','Keep only what you use.')}</p>${options.map(([id,ru,eng])=>`<label class="layout-option"><span>${text(ru,eng)}</span><input type="checkbox" data-layout-option="${id}" ${preferences(key)[id]?'checked':''}></label>`).join('')}<button type="button" class="btn btn-ghost" data-layout-reset>${text('Вернуть простой вид','Restore simple layout')}</button></div>`;
  wrapper.addEventListener('change',event=>{const id=event.target.dataset.layoutOption;if(!id)return;preferences(key)[id]=event.target.checked;try{localStorage.setItem('xlam-panel-layout:'+key,JSON.stringify(preferences(key)));}catch(_){}apply(card);});
  wrapper.querySelector('[data-layout-reset]').addEventListener('click',()=>{prefs.set(key,{});try{localStorage.removeItem('xlam-panel-layout:'+key);}catch(_){}wrapper.querySelectorAll('input').forEach(input=>input.checked=false);apply(card);});
  card.querySelector('.controls')?.append(wrapper);
 }
 function enhance(){document.querySelectorAll('#deviceGrid > .device-card').forEach(card=>{
  editor(card);apply(card);
  const picker=card.querySelector('[data-brawler-details]');
  if(picker&&!picker.dataset.flyoutReady){picker.dataset.flyoutReady='true';picker.classList.add('flyout','brawler-picker');const body=document.createElement('div');body.className='flyout-body brawler-picker-body';[...picker.children].filter(el=>el.tagName!=='SUMMARY').forEach(el=>body.append(el));picker.append(body);}
 });}

 const grid=document.getElementById('deviceGrid');
 if(new URLSearchParams(location.search).has('device'))document.body.classList.add('device-detail-page');
 if(grid){new MutationObserver(enhance).observe(grid,{childList:true,subtree:true});enhance();}
 function placeFlyout(el){
  const panel=el.querySelector(':scope > .flyout-body');if(!panel)return;
  for(const prop of ['left','right','top','bottom','max-height'])panel.style.removeProperty(prop);
  if(!el.open||innerWidth<=760)return;
  const rect=el.getBoundingClientRect(),above=Math.max(0,rect.top-22),below=Math.max(0,innerHeight-rect.bottom-22);
  const preferBelow=el.matches('.personal-tuning,.studio-more');
  const natural=panel.offsetHeight;
  const down=preferBelow ? below>=natural||below>above : !(above>=natural||above>=below);
  panel.style.maxHeight=Math.max(100,down?below:above)+'px';
  const left=Math.max(12,Math.min(rect.left,innerWidth-panel.offsetWidth-12));
  panel.style.left=(left-rect.left)+'px';panel.style.right='auto';
  panel.style.top=down?'calc(100% + 10px)':'auto';panel.style.bottom=down?'auto':'calc(100% + 10px)';
 }
 document.addEventListener('toggle',event=>{if(event.target.matches('.flyout'))placeFlyout(event.target);},true);
 window.addEventListener('resize',()=>document.querySelectorAll('.flyout[open]').forEach(placeFlyout));
 document.addEventListener('pointerover',event=>{const el=event.target.closest('.flyout');if(el&&innerWidth>760&&event.pointerType!=='touch'&&!el.contains(event.relatedTarget))el.open=true;});
 document.addEventListener('pointerout',event=>{const el=event.target.closest('.flyout');if(el&&!el.contains(event.relatedTarget)&&el.dataset.pinned!=='true'&&!el.contains(document.activeElement))el.open=false;});
 document.addEventListener('focusin',event=>{const el=event.target.closest('.flyout');if(el&&innerWidth>760)el.open=true;});
 document.addEventListener('focusout',event=>{const el=event.target.closest('.flyout');if(el&&!el.contains(event.relatedTarget)&&el.dataset.pinned!=='true')el.open=false;});
 document.addEventListener('click',event=>{
  const summary=event.target.closest('.flyout > summary');
  if(summary){event.preventDefault();const el=summary.parentElement;el.dataset.pinned=String(el.dataset.pinned!=='true');el.open=el.dataset.pinned==='true';}
  document.querySelectorAll('.flyout[open]').forEach(el=>{if(!el.contains(event.target)){el.open=false;el.dataset.pinned='false';}});
 });
 document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelectorAll('.flyout[open]').forEach(el=>{el.open=false;el.dataset.pinned='false';if(el.contains(document.activeElement))document.activeElement.blur();});});
 // Shared settings endpoint and semantics on the personal settings page.
 const levels=['low','standard','medium','high','maximum'];
 const names=()=>en()?['Low','Standard','Medium','High','Maximum']:['Низкий','Стандарт','Средний','Высокий','Максимальный'];
 const modes=()=>en()?['Bush camping','Survival','Balanced','Aggressive','Onslaught']:['Сидеть в кустах','Выживание','Баланс','Агрессия','Натиск'];
 async function api(path,body){const response=await window.XlamSession.fetch(path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Xlam-UI-Token':document.querySelector('meta[name="xlam-ui-token"]').content},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok||result.ok===false)throw Error(result.message||text('Не удалось сохранить','Could not save'));return result;}
 async function mountControl(host,key){
  if(host.dataset.mounted===key)return;host.dataset.mounted=key;
  host.innerHTML=`<details class="flyout personal-tuning"><summary class="btn btn-ghost">ϟ ${text('Управление ботом','Bot controls')} <span aria-hidden="true">⌄</span></summary><div class="flyout-body"><div class="flyout-title">${text('Управление ботом','Bot controls')}</div><label>Think <strong data-think-name></strong><input data-personal-think type="range" min="0" max="4" disabled></label><p>${text('Больше анализа — точнее выбор пути. Настройка отдельно для этого устройства.','More analysis improves path choices. Saved separately for this device.')}</p><label>${text('Режим работы','Bot mode')} <strong data-mode-name></strong><input data-personal-mode type="range" min="1" max="5" disabled></label><div class="mode-scale"><span>${modes()[0]}</span><span>${modes()[4]}</span></div><p data-save-state role="status"></p></div></details>`;
  try{
   const sections=(await api(`/api/devices/${encodeURIComponent(key)}/settings`)).settings;const settings=sections.bot_config;settings.thinking_mode=sections.general_config.thinking_mode;
   if(!host.isConnected)return;
   const think=host.querySelector('[data-personal-think]'),mode=host.querySelector('[data-personal-mode]'),status=host.querySelector('[data-save-state]');
   think.value=Math.max(0,levels.indexOf(settings.thinking_mode||'medium'));mode.value=settings.work_mode||2;think.disabled=mode.disabled=false;
   const paint=()=>{host.querySelector('[data-think-name]').textContent=names()[think.value];host.querySelector('[data-mode-name]').textContent=modes()[mode.value-1];};paint();
   for(const input of [think,mode]){input.addEventListener('input',paint);input.addEventListener('change',async()=>{think.disabled=mode.disabled=true;status.textContent=text('Сохраняю…','Saving…');try{await api(`/api/devices/${encodeURIComponent(key)}/settings`,{section:input===think?'cfg/general_config.toml':'cfg/bot_config.toml',values:input===think?{thinking_mode:levels[think.value]}:{work_mode:Number(mode.value)}});status.textContent=text('Сохранено для этого устройства','Saved for this device');}catch(e){status.textContent=e.message;host.dataset.mounted='';await mountControl(host,key);}finally{think.disabled=mode.disabled=false;}});}
  }catch(e){host.querySelector('[data-save-state]').textContent=e.message;host.dataset.mounted='';}
 }
 window.addEventListener('xlam-language-changed',()=>{
  document.querySelectorAll('.panel-customizer').forEach(el=>el.remove());
  enhance();
  document.querySelectorAll('[data-personal-control]').forEach(host=>{
   host.dataset.mounted='';mountControl(host,host.dataset.personalControl);
  });
 });
 window.XlamDeviceExperience={mountControl,escape};
})();
