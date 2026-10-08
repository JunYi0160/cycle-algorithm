import {createServer} from 'node:http';
import {readFileSync,statSync} from 'node:fs';
import {dirname,resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../dist');
const args=process.argv.slice(2),value=(key,fallback)=>{const i=args.indexOf(key);return i>=0?args[i+1]:fallback;};
const base=value('--base','/cycle-algorithm/'),port=Number(value('--port','8788'));
if(!/^\/(?:[\w-]+\/)*$/.test(base))throw new Error('--base 必须是以 / 开始和结束的路径');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.csv':'text/csv; charset=utf-8'};
createServer((req,res)=>{
  try{
    const path=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    if(path===base.slice(0,-1)){res.writeHead(302,{Location:base});res.end();return;}
    if(!path.startsWith(base)){res.writeHead(404);res.end('Not found');return;}
    const file=resolve(root,path.slice(base.length)||'index.html');
    if(!file.startsWith(root+sep)||!statSync(file).isFile()){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(readFileSync(file));
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Static preview: http://127.0.0.1:${port}${base}`));
