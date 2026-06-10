import { createRequire } from 'module';
const require = createRequire('/Users/hyunie/Desktop/Aave-DependencyMap/risk-exposure-monitoring/frontend/');
const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const OUT = new URL('./assets/', import.meta.url).pathname;
const b = await chromium.launch();

async function shoot(path, file, { w=1600, h=760, waitGraph=false, fit=false }={}) {
  const page = await b.newPage({ viewport:{width:w,height:h}, deviceScaleFactor:2 });
  await page.goto(BASE+path, { waitUntil:'networkidle', timeout:60000 }).catch(()=>{});
  if (waitGraph) { await page.waitForSelector('.react-flow__node', { timeout:30000 }).catch(()=>{}); }
  await page.waitForTimeout(2500);
  if (fit) { const fv = await page.$('.react-flow__controls-fitview'); if (fv){ await fv.click(); await page.waitForTimeout(400); await fv.click(); await page.waitForTimeout(1000);} }
  await page.screenshot({ path: OUT+file });
  const dims = await page.evaluate(()=>({nodes:document.querySelectorAll('.react-flow__node').length, title:document.title}));
  console.log(file, '->', JSON.stringify(dims));
  await page.close();
}

await shoot('/token/USDe', 'token-usde.png', { w:1680, h:760, waitGraph:true, fit:true });
await shoot('/', 'landing.png', { w:1680, h:1000 });
await b.close();
console.log('DONE');
