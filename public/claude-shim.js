// Runs Questlog outside claude.ai: maps the claude.ai runtime (user, db, sample) onto this app's own /api.
(function(){
if(window.claude)return;
window.QL_STANDALONE=true;
const st=document.createElement('style');st.textContent='.sa{display:block!important}#gateSync{display:none!important}';document.head.appendChild(st);
const J={'Content-Type':'application/json'};
let ME;
async function me(){if(ME!==undefined)return ME;try{const r=await fetch('/api/me');ME=r.ok?await r.json():null}catch(e){ME=null}return ME}
async function call(prompt,tier,images){
  const r=await fetch('/api/ai',{method:'POST',headers:J,body:JSON.stringify({prompt,tier,images})});
  if(r.status===429){const e=new Error('rate');e.code='rate_limited';throw e}
  if(!r.ok)throw new Error('ai');
  return (await r.json()).text||'';
}
const b64=b=>new Promise((res,rej)=>{const f=new FileReader();f.onload=()=>res({type:b.type||'image/jpeg',data:String(f.result).split(',')[1]});f.onerror=rej;f.readAsDataURL(b)});
const sample=async(prompt,o={})=>{const text=await call(prompt,o.modelTier);if(o.onText)o.onText({text});return{text}};
sample.json=async(prompt,o={})=>{
  const imgs=o.images?await Promise.all(o.images.map(b64)):undefined;
  const t=await call(prompt,o.modelTier,imgs);const m=t.match(/\{[\s\S]*\}/);
  if(!m)throw new Error('json');return JSON.parse(m[0]);
};
sample.limits=async()=>({images:true});
const db={
  doc(p){const m=/^data\/users\/[^/]+\/([a-z]+)$/.exec(p);return{
    async get(){if(!m)return{exists:false,data:()=>null};const r=await fetch('/api/doc/'+m[1]);if(r.status===404)return{exists:false,data:()=>null};if(!r.ok)throw new Error('get');const d=await r.json();return{exists:true,data:()=>d}},
    async set(d){if(!m)throw new Error('unsupported');const r=await fetch('/api/doc/'+m[1],{method:'PUT',headers:J,body:JSON.stringify(d)});if(!r.ok)throw new Error('save')},
    async delete(){throw new Error('unsupported')}}},
  collection(){return{onSnapshot(){}}}
};
window.claude={use:async n=>{
  const u=await me();
  if(n==='user')return{me:async()=>u||{}};
  if(n==='sample')return sample;
  if(!u)return null;
  return n==='db'?db:null;
}};
})();
