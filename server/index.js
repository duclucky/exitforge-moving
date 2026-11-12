import { createApp } from './app.js';
if(process.env.NODE_ENV==='production'&&(!process.env.APP_URL?.startsWith('https://')||!process.env.PAYPAL_CLIENT_SECRET||!process.env.AI_API_KEY))throw new Error('Production requires an HTTPS APP_URL and server-side integration configuration.');
const app=createApp({database:process.env.DATABASE_PATH||'data/exitforge.sqlite',setup:!process.env.AI_API_KEY || !process.env.PAYPAL_CLIENT_SECRET});
const port=Number(process.env.PORT||4174);
const server=app.listen(port,process.env.HOST||'127.0.0.1',()=>{
  console.log(`ExitForge API http://127.0.0.1:${port}`);
  if(app.locals.setupPath)console.log('Local configuration page http://127.0.0.1:'+port+app.locals.setupPath);
});
function shutdown(){server.close(()=>{app.locals.db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
