/* Five deliberate choices; custom values stay intact until the user moves a control. */
(function () {
 'use strict';
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const en=()=>document.documentElement.lang==='en';
 const text=(ru,eng)=>en()?eng:ru;
 const fixed={max_fps:['auto',15,30,60,120],used_threads:['auto',1,2,4,8],
  thinking_mode:['low','standard','medium','high','maximum'],work_mode:[1,2,3,4,5],
  brawler_switch_after_games:[0,1,3,7,15],preview_interval_ms:[1500,1000,600,400,200],
  scrcpy_max_fps:[15,25,35,50,60],scrcpy_max_width:[640,960,1280,1600,1920],
  scrcpy_bitrate:[1000000,2000000,4000000,6000000,8000000],run_for_minutes:[0,30,60,120,240],
  state_detection_confidence:[.5,.6,.75,.85,.95],wall_detection_confidence:[.3,.45,.6,.75,.9],
  entity_detection_confidence:[.3,.45,.55,.7,.85],gas_confidence:[.15,.2,.25,.35,.5]};
 const identifiers=new Set(['emulator_port','telegram_chat_id','discord_id','discord_guild_id']);
 const modes=()=>en()?['Bush camping','Survival','Balanced','Aggressive','Onslaught']:['Сидеть в кустах','Выживание','Баланс','Агрессия','Натиск'];
 const thoughts=()=>en()?['Low','Standard','Medium','High','Maximum']:['Низкий','Стандарт','Средний','Высокий','Максимальный'];
 const modeNotes=()=>en()?['Waits in cover; moves every 3 seconds and escapes gas or incoming attacks.','Stays with active allies and retreats from overwhelming groups.','Supports allies and chooses manageable fights.','Pursues accessible targets while keeping the brawler’s range.','Pressures opponents more closely; still avoids gas.']:['Ждёт в укрытии, двигается раз в 3 секунды, уходит от газа и атак.','Держится с активными союзниками и отходит от перевеса врагов.','Помогает союзникам и выбирает посильные бои.','Преследует доступные цели, сохраняя дистанцию бойца.','Сильнее давит на врагов; продолжает избегать газа.'];
 function levels(key,value){
  if(fixed[key])return fixed[key];
  if(typeof value!=='number'||!Number.isFinite(value)||identifiers.has(key))return null;
  const bounded=/(confidence|gas_area_|gas_danger_|gas_centre_bias)/.test(key);
  const base=value|| (bounded?.2:1), integer=Number.isInteger(value);
  if(integer&&!bounded&&value<4)return [0,1,2,4,8];
  if(bounded)return [.1,.25,.5,.75,.95];
  return [0.5,.75,1,1.5,2].map(f=>{const n=Math.max(0,base*f);return integer?Math.round(n):Number(n.toPrecision(8));});
 }
 function name(key,value,index){
  if(key==='thinking_mode')return thoughts()[index];
  if(key==='work_mode')return modes()[index];
  if(value==='auto')return text('Автоматически','Automatic');
  if((key==='run_for_minutes'||key==='brawler_switch_after_games')&&value===0)return text('Без ограничения','No limit');
  if(key==='preview_interval_ms')return value+' '+text('мс','ms');
  if(key==='run_for_minutes')return value+' '+text('мин','min');
  if(key==='scrcpy_max_width')return value+' px';
  if(key==='scrcpy_bitrate')return (value/1000000)+' Mbps';
  if(['max_fps','scrcpy_max_fps','debug_view_fps'].includes(key))return value+' FPS';
  return String(value);
 }
 function note(key,index,hint){
  if(key==='work_mode')return modeNotes()[index];
  if(key==='thinking_mode')return (en()?['Less frequent path checks with a short planning horizon. Uses fewer resources.','Keeps the original check intervals and planning behavior.','Checks the surroundings more frequently and considers more directions.','Considers more directions and plans farther ahead. Needs more resources.','Most frequent checks and the longest planning horizon. Choose with spare PC capacity.']:['Реже проверяет путь и планирует короткие движения. Меньше работы для ПК.','Сохраняет первоначальные интервалы проверок и планирование.','Чаще проверяет окружение и рассматривает больше направлений.','Рассматривает больше направлений и планирует дальше. Требует больше ресурсов.','Самые частые проверки и самый дальний план пути. Выбирай при запасе мощности ПК.'])[index];
  if(key==='preview_interval_ms')return text('Правее — превью обновляется чаще. На частоту решений в игре не влияет.','Further right updates the preview more often. It does not change gameplay decisions.');
  if(key==='brawler_switch_after_games')return text('После этого числа матчей бот выберет следующего бойца. 0 — не менять бойца.','After this many battles the bot selects another brawler. 0 keeps the same brawler.');
  if(key==='max_fps')return text('Ограничивает частоту обработки. Высокий предел не гарантирует такой FPS.','Limits processing rate. A higher cap does not guarantee that FPS.');
  if(key==='used_threads')return text('Больше потоков может ускорить распознавание, если есть свободный процессор. Автоматически — 2 потока на модель.','More threads may speed up recognition if CPU capacity is available. Automatic uses 2 threads per model.');
  if(key==='scrcpy_max_fps')return text('Больше кадров даёт более свежий видеопоток, но увеличивает работу захвата.','More frames keep the video feed fresher and increase capture workload.');
  if(key==='scrcpy_max_width')return text('Шире изображение — лучше видны мелкие цифры, но обработка тяжелее.','Wider frames preserve small numbers better and take more work to process.');
  if(key==='scrcpy_bitrate')return text('Выше — меньше потерь мелких деталей и больше данных видеопотока.','Higher values preserve finer detail and increase video data volume.');
  if(/confidence/.test(key))return text('Выше — строже распознавание: меньше ложных находок, но возможны пропуски.','Higher values make recognition stricter: fewer false positives, with more possible misses.');
  return hint;
 }
 function html(key,value,attrs,id,hint=''){
  const values=levels(key,value);if(!values)return null;
  const index=values.findIndex(v=>v===value),custom=index<0,position=custom?2:index;
  const label=custom?text('Свое значение: ','Custom value: ')+value:name(key,value,position);
  const exact=key!=='work_mode'&&(typeof value==='number'||['max_fps','used_threads'].includes(key))?`<details class="slider-exact"><summary>${text('Точное значение','Exact value')}</summary><input class="input" id="${id}-exact" ${attrs} type="${typeof value==='number'?'number':'text'}" value="${esc(value)}" ${typeof value==='number'?'min="0" step="any"':''} aria-label="${text('Точное значение','Exact value')}"></details>`:'';
  return `<div class="step-control" data-slider-key="${esc(key)}" data-i18n-skip><div class="step-control-head"><output for="${id}" class="step-value">${esc(label)}</output><span class="step-count">${custom?'—':position+1} / 5</span></div><input id="${id}" type="range" min="0" max="4" step="1" value="${position}" ${attrs} data-presets="${esc(JSON.stringify(values))}" data-custom="${custom}" data-custom-value="${esc(value)}" aria-valuetext="${esc(label)}" style="--fill:${position*25}%"><div class="step-dots" aria-hidden="true">${values.map((v,i)=>`<span class="${i===position&&!custom?'is-active':''}"></span>`).join('')}</div><p class="step-note">${esc(note(key,position,hint))}</p>${exact}</div>`;
 }
 function value(input){return input.dataset.presets?JSON.parse(input.dataset.presets)[Number(input.value)]:Number(input.value);}
 function paint(input){
  const host=input.closest('.step-control');if(!host||!input.dataset.presets)return;
  const key=host.dataset.sliderKey,index=Number(input.value),val=value(input),label=name(key,val,index);
  input.dataset.custom='false';input.style.setProperty('--fill',index*25+'%');input.setAttribute('aria-valuetext',label);
  host.querySelector('.step-value').textContent=label;host.querySelector('.step-count').textContent=(index+1)+' / 5';
  host.querySelectorAll('.step-dots span').forEach((el,i)=>el.classList.toggle('is-active',i===index));
  if(['work_mode','thinking_mode'].includes(key))host.querySelector('.step-note').textContent=note(key,index,'');
  const exact=host.querySelector('.slider-exact input');if(exact)exact.value=val;
 }
 document.addEventListener('input',event=>paint(event.target));
 document.addEventListener('change',event=>{
  const exact=event.target.closest('.slider-exact');if(!exact)return;
  const host=exact.closest('.step-control'),range=host.querySelector('input[type="range"]');
  const entered=event.target.type==='number'?Number(event.target.value):event.target.value;
  const values=JSON.parse(range.dataset.presets),index=values.findIndex(v=>v===entered);
  range.dataset.custom=String(index<0);range.dataset.customValue=String(entered);
  if(index>=0){range.value=index;paint(range);}else{host.querySelector('.step-value').textContent=text('Свое значение: ','Custom value: ')+entered;host.querySelector('.step-count').textContent='— / 5';range.setAttribute('aria-valuetext',host.querySelector('.step-value').textContent);}
 });
 window.addEventListener('xlam-language-changed',()=>document.querySelectorAll('.step-control').forEach(host=>{
  const range=host.querySelector('input[type="range"]'),key=host.dataset.sliderKey;
  if(range.dataset.custom==='true'){host.querySelector('.step-value').textContent=text('Свое значение: ','Custom value: ')+range.dataset.customValue;range.setAttribute('aria-valuetext',host.querySelector('.step-value').textContent);}
  else paint(range);
  const meta=window.XlamSettingsFields?.[key];host.querySelector('.step-note').textContent=note(key,Number(range.value),meta?.[en()?3:2]||'');
  const exact=host.querySelector('.slider-exact summary');if(exact)exact.textContent=text('Точное значение','Exact value');
  const input=host.querySelector('.slider-exact input');if(input)input.setAttribute('aria-label',text('Точное значение','Exact value'));
 }));
 window.XlamSliders={html,value,levels,modes,thoughts};
})();
