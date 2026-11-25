(function(){
'use strict';
const root=document.getElementById('ai-video-studio');if(!root)return;
const $=id=>document.getElementById(id),form=$('spvForm'),field=$('spvPrompt'),button=$('spvGenerate'),msg=$('spvStatus'),list=$('spvJobs'),player=$('spvPlayer');
let selected='9:16',busy=false,recent=[],polling=false;
function tell(text,error){msg.textContent=text;msg.classList.toggle('spv-error',!!error);}
function node(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
async function call(action,payload={}){
 const client=typeof authClient!=='undefined'?authClient:null;
 const config=window.SOCIALPILOT_SUPABASE||{};
 if(!client)throw new Error('Authentication is loading. Please refresh and sign in.');
 const {data:{session}}=await client.auth.getSession();
 if(!session)throw new Error('Sign in to use AI Video Studio.');
 if(!config.url||!config.publishableKey)throw new Error('The website backend is not configured.');
 const res=await fetch(config.url.replace(/\/$/,'')+'/functions/v1/generate-video',{
 method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token,'apikey':config.publishableKey},body:JSON.stringify({action,...payload})
 });
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error(data.error||'The video service is temporarily unavailable.');
 return data;
}
function view(url){if(typeof url!=='string'||!url.startsWith('https://'))return;
 player.src=url;player.classList.add('spv-playing');$('spvPlaceholder').hidden=true;
 player.scrollIntoView({behavior:'smooth',block:'nearest'});
 player.play().catch(()=>tell('Video ready. Press play to watch.'));
}
function render(items){
 recent=items;list.replaceChildren();
 if(!items.length){list.append(node('p','No videos yet. Your first render will appear here.','spv-empty'));return;}
 for(const job of items){
 const card=node('article',undefined,'spv-job'),status=node('small',job.aspect_ratio+' · '+(job.status==='completed'?'READY':job.status==='failed'?'FAILED':'RENDERING'));
 card.append(status,node('p',job.prompt||'Untitled video'));
 if(job.status==='completed'&&job.video_url){
 const play=node('button','▶ Play video');play.type='button';play.addEventListener('click',()=>view(job.video_url));
 const open=node('a','Open MP4');open.href=job.video_url;open.target='_blank';open.rel='noopener noreferrer';
 card.append(play,document.createTextNode('  ·  '),open);
 const publish=node('button','Publish to TikTok');
 publish.type='button';
 publish.hidden=true;
 publish.dataset.tiktokPublish='';
 publish.addEventListener('click',()=>window.dispatchEvent(new CustomEvent('av:tiktok-publish',{detail:job})));
 card.append(publish);
 window.dispatchEvent(new CustomEvent('av:tiktok-controls',{detail:publish}));
 }else if(job.status==='failed'){
   card.append(node('small','Could not complete the video'));
   const remove=node('button','Remove failed project');
   remove.type='button';
   remove.addEventListener('click',async()=>{
     remove.disabled=true;
     try {
       await call('dismiss',{id:job.id});
       render(recent.filter(item=>item.id!==job.id));
       $('spvRefresh').focus();
       tell('Failed project removed. Monthly usage is unchanged.');
     } catch(error) {
       remove.disabled=false;
       tell(error.message,true);
     }
   });
   card.append(remove);
 }
 else{const check=node('button','Check progress');check.type='button';check.addEventListener('click',()=>checkJob(job.id));card.append(check);}
 list.append(card);
 }
}
async function reload(silent=false){try{const data=await call('list');render(Array.isArray(data.jobs)?data.jobs:[]);if(!silent)tell('Projects updated.');}catch(error){if(!silent)tell(error.message,true);}}
async function checkJob(id){try{const result=await call('status',{id});
 if(result.status==='completed'&&result.video_url){view(result.video_url);tell('Your AI video is ready.');}
 else if(result.status==='failed'){tell(result.error||'This generation failed.',true);}
 else{tell('Your video is still rendering. Check again shortly.');}
 await reload(true);
 }catch(error){tell(error.message,true);}}
root.querySelectorAll('.spv-ratio').forEach(btn=>btn.addEventListener('click',()=>{selected=btn.dataset.ratio;root.querySelectorAll('.spv-ratio').forEach(x=>x.setAttribute('aria-pressed',String(x===btn)));}));
field.addEventListener('input',()=>{$('spvCount').textContent=field.value.length+'/1200';});
$('spvCount').textContent=field.value.length+'/1200';
form.addEventListener('submit',async event=>{
 event.preventDefault();if(busy)return;const prompt=field.value.trim();
 if(prompt.length<12||prompt.length>1200){tell('Please enter a description between 12 and 1200 characters.',true);return;}
 busy=true;button.disabled=true;button.textContent='Submitting render…';tell('Preparing your video request…');
 try{const result=await call('create',{prompt,aspect_ratio:selected,audio:form.elements.audio?.checked===true});tell(result.message||'Rendering started.');await reload(true);}
 catch(error){tell(error.message,true);if(/sign in/i.test(error.message)&&typeof openAuth==='function')openAuth('login');}
 finally{busy=false;button.disabled=false;button.textContent='✦ Generate my AI video';}
});
$('spvRefresh').addEventListener('click',()=>reload());
if('IntersectionObserver' in window){const ob=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){reload(true);ob.disconnect();}},{rootMargin:'100px'});ob.observe(root);}
setInterval(async()=>{if(document.hidden||busy||polling)return;const pending=recent.filter(x=>x.status==='submitted').slice(0,3);if(!pending.length)return;
 polling=true;
 try{for(const j of pending){try{const result=await call('status',{id:j.id});if(result.status==='completed')tell('Your AI video is ready. Open it from your projects.');else if(result.status==='failed')tell('A video generation failed. Check your projects.',true);}catch{}}
 await reload(true);}finally{polling=false;}},15000);
})();