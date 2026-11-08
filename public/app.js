const role=document.querySelector('#role');const list=document.querySelector('#requests');const notice=document.querySelector('#notice');
const labels={submitted:'Отправлено',in_review:'На рассмотрении',in_progress:'В работе',resolved:'Решено',rejected:'Отклонено',reopened:'Пересмотр'};
const routes={submitted:['in_review','rejected'],in_review:['in_progress','resolved','rejected'],in_progress:['resolved','rejected'],resolved:['reopened'],rejected:['reopened'],reopened:['in_review','in_progress']};
function el(name,cls,text){const e=document.createElement(name);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','Authorization':'Bearer '+role.value,...options.headers}});const data=await response.json();if(!response.ok)throw Error(data.error||'Ошибка');return data;}
async function load(){try{const data=await api('/api/requests');document.querySelector('#count').textContent=data.length;list.replaceChildren();if(!data.length)list.append(el('p','empty','Пока нет обращений. Создайте первое.'));for(const item of data){const card=el('article','request');const top=el('div','request-head');top.append(el('b',null,item.title),el('span','status',labels[item.status]));card.append(top,el('p',null,item.description),el('small',null,(item.kind==='idea'?'Идея':'Проблема')+' · '+new Date(item.createdAt).toLocaleString('ru-RU')));const actions=el('div','actions');for(const status of routes[item.status]||[]){if(role.value==='demo-employee'&&status!=='reopened')continue;if(role.value==='demo-manager'&&status==='reopened')continue;const b=el('button','secondary',labels[status]);b.type='button';b.addEventListener('click',async()=>{try{await api('/api/requests/'+item.id+'/status',{method:'PATCH',body:JSON.stringify({status})});notice.textContent='Статус обновлён';await load();}catch(e){notice.textContent=e.message;}});actions.append(b);}card.append(actions);list.append(card);}}catch(e){notice.textContent=e.message;}}
document.querySelector('#form').addEventListener('submit',async(e)=>{e.preventDefault();const f=e.currentTarget;const data=Object.fromEntries(new FormData(f));try{await api('/api/requests',{method:'POST',body:JSON.stringify(data)});f.reset();notice.textContent='Обращение зарегистрировано';await load();}catch(error){notice.textContent=error.message;}});
role.addEventListener('change',load);document.querySelector('#reload').addEventListener('click',load);load();

const draftSteps=[['observation','Что я заметил?'],['cause','Почему так происходит?'],['evidence','Что подтверждает наблюдение?'],['proposal','Что предлагаю изменить?'],['risks','Что может пойти не так?'],['pilot','Как проверить с минимальными затратами?']];
async function loadDrafts(){
 const root=document.querySelector('#drafts');if(!root)return;
 try{
  const data=await api('/api/drafts');root.replaceChildren();
  if(!data.length)root.append(el('p','empty','Создайте первую приватную идею.'));
  for(const d of data){
   const card=el('article','request');card.append(el('b',null,d.title),el('small',null,d.state==='private'?' · Приватно':' · Опубликовано'));
   if(d.state==='private'){
    for(const [step,label] of draftSteps){
     const wrap=el('label');wrap.append(el('span',null,label));
     const field=el('textarea');field.value=d.steps[step]||'';field.rows=2;field.maxLength=5000;wrap.append(field);
     const save=el('button','secondary','Сохранить шаг');save.type='button';
     save.addEventListener('click',async()=>{try{await api('/api/drafts/'+d.id,{method:'PATCH',body:JSON.stringify({step,text:field.value})});notice.textContent='Шаг сохранён';}catch(e){notice.textContent=e.message;}});
     card.append(wrap,save);
    }
    const publish=el('button',null,'Опубликовать идею');publish.type='button';
    publish.addEventListener('click',async()=>{if(!confirm('Опубликовать подготовленную идею для коллег? Приватные заметки не публикуются.'))return;try{await api('/api/drafts/'+d.id+'/publish',{method:'POST',body:'{}'});notice.textContent='Идея опубликована';await load();await loadDrafts();}catch(e){notice.textContent=e.message;}});
    card.append(publish);
   }
   root.append(card);
  }
 }catch(e){notice.textContent=e.message;}
}
document.querySelector('#draft-create').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;try{await api('/api/drafts',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});form.reset();notice.textContent='Приватная идея создана';await loadDrafts();}catch(error){notice.textContent=error.message;}});
role.addEventListener('change',loadDrafts);loadDrafts();
