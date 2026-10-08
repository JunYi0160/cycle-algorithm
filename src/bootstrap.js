// Static hosts control HTTP headers. A fresh release manifest detects cached HTML;
// the build versions all scripts and their imports together. Never clear user storage.
export const BUILD_VERSION='__BUILD_VERSION__';

export function releaseURL(href,version){
  const url=new URL(href);
  url.searchParams.set('v',version);
  return url.href;
}

export async function fetchRelease(base,fetcher=fetch){
  const url=new URL('release.json',base);
  url.searchParams.set('check',String(Date.now()));
  const response=await fetcher(url.href,{cache:'no-store',signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw new Error('Release check unavailable');
  const release=await response.json();
  if(!/^[a-f0-9]{16}$/.test(release.version))throw new Error('Invalid release version');
  return release.version;
}

async function boot(){
  const base=new URL('../',import.meta.url);
  // Limit legacy worker cleanup to this application; other Pages projects share an origin.
  if('serviceWorker' in navigator){
    try{
      const registrations=await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.filter(r=>r.scope.startsWith(base.href)).map(r=>r.unregister()));
    }catch{/* A worker inspection failure must not block local calculations. */}
  }
  const current=new URL(location.href);
  try{
    const latest=await fetchRelease(base);
    if(latest!==BUILD_VERSION&&current.searchParams.get('v')!==latest){
      location.replace(releaseURL(location.href,latest));
      return;
    }
  }catch{/* Keep the cached application usable when the network is unavailable. */}
  await import('./app.js');
  let checking=false;
  async function check(){
    if(checking||document.visibilityState==='hidden')return;
    checking=true;
    try{
      const latest=await fetchRelease(base);
      const notice=document.getElementById('release-update');
      notice.hidden=latest===BUILD_VERSION;
      if(!notice.hidden)document.getElementById('release-refresh').onclick=()=>{
        location.assign(releaseURL(location.href,latest));
      };
    }catch{/* Retry when the tab becomes visible or on the next timer. */}
    finally{checking=false;}
  }
  setInterval(check,60000);
  document.addEventListener('visibilitychange',check);
  window.addEventListener('pageshow',check);
  await check();
}

if(typeof window!=='undefined')boot().catch(error=>{
  const notice=document.getElementById('error');
  notice.hidden=false;
  notice.textContent='页面资源加载失败，请使用最新发布链接重新打开。'+error.message;
});
