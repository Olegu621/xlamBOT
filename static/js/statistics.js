(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 const words={ru:{kicker:'РЕЗУЛЬТАТ В ЦИФРАХ',title:'Статистика',subtitle:'Каждый бой — часть прогресса.',refresh:'Обновить',device:'Устройство',account:'Аккаунт',brawler:'Боец',today:'Сегодня',week:'7 дней',month:'30 дней',allTime:'Всё время',growth:'Прирост трофеев',wins:'Победы',matches:'Всего боёв',average:'Трофеи за бой',averageNote:'Среднее по боям с записью трофеев',dynamics:'ДИНАМИКА',chartTitle:'Трофеи в движении',cumulative:'Накопительно',byPeriod:'За период',chartNote:'Изменения из истории боёв. Пропуски — без записи трофеев.',balance:'БАЛАНС',outcomes:'Исходы боёв',winsLower:'побед',rhythm:'РИТМ ИГРЫ',activity:'Бои по дням',fighters:'БОЙЦЫ',fighterTitle:'Кто приносит результат',empty:'За выбранный период боёв нет. Статистика появится после завершённого боя.',allDevice:'Все устройства',allAccount:'Все аккаунты',allBrawler:'Все бойцы',unknownAccount:'Аккаунт не записан',losses:'Поражения',draws:'Ничьи',unknown:'Без результата',updated:'Обновлено',error:'Не удалось обновить статистику. Проверьте связь с ботом.',loading:'Загрузка…',measured:'боёв с записью трофеев из',fighterCount:'Бойцов за период',estimated:'Расчётные/старые записи трофеев:',quality:'Они основаны на истории боёв, а не на подтверждённом OCR общего счёта аккаунта.',bucket:'дн. на точку',poll:'обновление каждые 15 секунд',skipped:'Пропущено повреждённых записей:'},en:{kicker:'RESULTS IN NUMBERS',title:'Statistics',subtitle:'Every battle is part of your progress.',refresh:'Refresh',device:'Device',account:'Account',brawler:'Brawler',today:'Today',week:'7 days',month:'30 days',allTime:'All time',growth:'Trophy gain',wins:'Wins',matches:'Total battles',average:'Trophies per battle',averageNote:'Average of battles with trophy records',dynamics:'TREND',chartTitle:'Trophies in motion',cumulative:'Cumulative',byPeriod:'Per period',chartNote:'Changes from battle history. Gaps have no trophy record.',balance:'BALANCE',outcomes:'Battle outcomes',winsLower:'wins',rhythm:'PLAY RHYTHM',activity:'Battles by day',fighters:'BRAWLERS',fighterTitle:'Who brings results',empty:'No battles in this period. Statistics appear after a completed battle.',allDevice:'All devices',allAccount:'All accounts',allBrawler:'All brawlers',unknownAccount:'Account not recorded',losses:'Losses',draws:'Draws',unknown:'Unclassified',updated:'Updated',error:'Could not refresh statistics. Check your connection to the bot.',loading:'Loading…',measured:'battles with trophy records out of',fighterCount:'Brawlers in this period',estimated:'Estimated/legacy trophy records:',quality:'These come from battle history, not confirmed OCR of the account total.',bucket:'days per point',poll:'refreshes every 15 seconds',skipped:'Skipped damaged records:'}};
 let payload=null,period='7',chart='cumulative',requestId=0,controller=null;
 const lang=()=>window.XlamI18n?.language||document.documentElement.lang||'ru';
 const t=k=>(words[lang()]||words.ru)[k]||k;
 const locale=()=>lang()==='en'?'en-US':'ru-RU';
 const num=(n,d=0)=>n===null||!Number.isFinite(Number(n))?'—':Number(n).toLocaleString(locale(),{maximumFractionDigits:d});
 const signed=(n,d=0)=>n===null?'—':(n>0?'+':'')+num(n,d);
 const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function text(){
  for(const el of document.querySelectorAll('[data-stats-text]'))el.textContent=t(el.dataset.statsText);
  document.title='xlamBOT — '+t('title');
  document.querySelector('.stats-filters').setAttribute('aria-label',t('title'));
  document.querySelector('.stats-period').setAttribute('aria-label',t('byPeriod'));
 }
 function options(id,values,all,key){
  const el=$(id),selected=el.value;el.replaceChildren(new Option(t(all),''));
  for(const value of values){let label=value;if(key==='account'&&value.startsWith('unknown:'))label=t('unknownAccount')+' · '+value.slice(8);el.add(new Option(label,value));}
  if(values.includes(selected))el.value=selected;
 }
 function dateLabel(value){return new Date(value+'T12:00:00').toLocaleDateString(locale(),{day:'numeric',month:'short'});}
 function line(data){
  if(!payload.summary.matches){$('statsChart').textContent=t('empty');return;}
  const values=data.map(p=>p[chart]).filter(v=>v!==null),low=Math.min(0,...values),high=Math.max(1,...values),range=high-low;
  const x=i=>60+i*690/Math.max(1,data.length-1),y=v=>230-(v-low)*200/range;
  let markup='<svg viewBox="0 0 780 280" role="img" aria-label="'+escape(t('chartTitle'))+'"><title>'+escape(t('chartTitle'))+'</title>';
  for(let i=0;i<=4;i++){const v=low+range*i/4,yy=y(v);markup+=`<line x1="60" y1="${yy}" x2="750" y2="${yy}" stroke="#ffffff10" stroke-dasharray="3 5"/><text x="48" y="${yy+4}" text-anchor="end" fill="#8c96aa" font-size="11">${escape(num(v,1))}</text>`;}
  let path='';data.forEach((p,i)=>{const v=p[chart];if(v===null){path+=' ';return;}const previous=i>0&&data[i-1][chart]!==null;path+=(previous?' L':' M')+x(i)+' '+y(v);});
  markup+=`<path d="${path}" fill="none" stroke="#b8a1ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  data.forEach((p,i)=>{const v=p[chart];if(v!==null)markup+=`<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#cbb8ff" opacity="${data.length>35?.25:1}"><title>${escape(dateLabel(p.date))}: ${escape(signed(v,1))} · ${p.matches} ${escape(t('matches'))}</title></circle>`;});
  const indexes=[...new Set([0,Math.round((data.length-1)/4),Math.round((data.length-1)/2),Math.round((data.length-1)*.75),data.length-1])];
  for(const i of indexes)if(data[i])markup+=`<text x="${x(i)}" y="265" text-anchor="middle" fill="#8c96aa" font-size="11">${escape(dateLabel(data[i].date))}</text>`;
  $('statsChart').innerHTML=markup+'</svg>';
 }
 function render(){
  if(!payload)return;text();const s=payload.summary;
  options('statsDevice',payload.options.device,'allDevice','device');options('statsAccount',payload.options.account,'allAccount','account');options('statsBrawler',payload.options.brawler,'allBrawler','brawler');
  $('statsGrowth').textContent=signed(s.trophy_delta,1);$('statsMeasured').textContent=`${num(s.measured_matches)} ${t('measured')} ${num(s.matches)}`;
  const rate=s.win_rate===null?'—':num(s.win_rate,1)+'%';$('statsWinRate').textContent=rate;$('statsRingRate').textContent=rate;
  $('statsOutcomeNote').textContent=`${t('wins')}: ${num(s.wins)} · ${t('losses')}: ${num(s.losses)} · ${t('draws')}: ${num(s.draws)}`;
  $('statsMatches').textContent=num(s.matches);$('statsFightersCount').textContent=`${t('fighterCount')}: ${num(payload.fighters.length)}`;$('statsAverage').textContent=signed(s.trophies_per_match,2);
  $('statsUpdated').textContent=t('updated')+' '+new Date(payload.updated_at).toLocaleTimeString(locale());
  const outcomes=[['wins','#9bdda1'],['losses','#ffa479'],['draws','#b8a1ff'],['unknown','#677087']];let angle=0,segments=[];$('statsLegend').replaceChildren();
  for(const [key,color] of outcomes){const count=s[key],end=angle+360*count/Math.max(1,s.matches);segments.push(`${color} ${angle}deg ${end}deg`);angle=end;const row=document.createElement('div');row.className='stats-legend-row';row.innerHTML=`<i style="background:${color}"></i><span>${escape(t(key))}</span><strong>${num(count)}</strong>`;$('statsLegend').append(row);}
  $('statsRing').style.setProperty('--ring',s.matches?'conic-gradient('+segments.join(',')+')':'conic-gradient(#353b4c 0deg 360deg)');$('statsRing').setAttribute('aria-label',t('wins')+' '+rate);
  line(payload.series);$('statsBucket').textContent=`${payload.bucket_days} ${t('bucket')} · ${t('poll')}`;
  const maximum=Math.max(1,...payload.series.map(p=>p.matches));$('statsActivity').replaceChildren();
  for(const p of payload.series){const bar=document.createElement('div');bar.className='stats-bar';bar.tabIndex=0;bar.title=dateLabel(p.date)+' · '+num(p.matches)+' '+t('matches');bar.innerHTML=`<span style="height:${Math.max(1,p.matches/maximum*100)}%"></span><small>${escape(dateLabel(p.date))}</small>`;$('statsActivity').append(bar);}
  $('statsTable').replaceChildren();for(const row of payload.fighters){const tr=document.createElement('tr');tr.innerHTML=`<td>${escape(row.brawler)}</td><td>${num(row.matches)}</td><td>${num(row.wins)}</td><td class="${row.delta>=0?'stats-positive':'stats-negative'}">${signed(row.delta,1)}</td>`;$('statsTable').append(tr);}
  $('statsEmpty').hidden=s.matches>0;$('statsQuality').textContent=(s.estimated_matches?`${t('estimated')} ${num(s.estimated_matches)}. ${t('quality')}`:'')+(payload.skipped_rows?' '+t('skipped')+' '+num(payload.skipped_rows):'')+(payload.unreadable_devices?.length?' '+(lang()==='en'?'Unreadable device histories: ':'Не удалось прочитать историю устройств: ')+num(payload.unreadable_devices.length):'');
 }
 async function load(){
  const id=++requestId;controller?.abort();controller=new AbortController();const current=controller;
  const timer=setTimeout(()=>current.abort(),12000);$('statsRefresh').disabled=true;
  try{const query=new URLSearchParams({period,device:$('statsDevice').value,account:$('statsAccount').value,brawler:$('statsBrawler').value});
   const response=await fetch('/api/statistics?'+query,{cache:'no-store',headers:{'X-Xlam-UI-Token':document.querySelector('meta[name="xlam-ui-token"]').content},signal:current.signal});
   if(!response.ok)throw new Error('HTTP '+response.status);const data=await response.json();if(!data.ok)throw new Error('Invalid data');if(id!==requestId)return;
   payload=data;$('statsError').hidden=true;render();
  }catch(error){if(id===requestId){$('statsError').textContent=t('error');$('statsError').hidden=false;}}
  finally{clearTimeout(timer);if(id===requestId)$('statsRefresh').disabled=false;}
 }
 text();options('statsDevice',[],'allDevice');options('statsAccount',[],'allAccount');options('statsBrawler',[],'allBrawler');
 for(const id of ['statsDevice','statsAccount','statsBrawler'])$(id).addEventListener('change',load);
 for(const button of document.querySelectorAll('[data-period]'))button.addEventListener('click',()=>{period=button.dataset.period;for(const b of document.querySelectorAll('[data-period]')){b.classList.toggle('is-active',b===button);b.setAttribute('aria-pressed',String(b===button));}load();});
 for(const button of document.querySelectorAll('[data-chart]'))button.addEventListener('click',()=>{chart=button.dataset.chart;for(const b of document.querySelectorAll('[data-chart]')){b.classList.toggle('is-active',b===button);b.setAttribute('aria-pressed',String(b===button));}if(payload)line(payload.series);});
 $('statsRefresh').addEventListener('click',load);window.addEventListener('xlam-language-changed',()=>{text();render();if(!$('statsError').hidden)$('statsError').textContent=t('error');});
 load();setInterval(()=>{if(!document.hidden&&!$('statsRefresh').disabled)load();},15000);
})();
