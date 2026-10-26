const M=require(process.argv[2]+"/js/model.js");const D=M.DEF;
const N=+process.argv[3]||200, scn=process.argv[4]||"中性", targets=(process.argv[5]||"8,10").split(",").map(Number);
// RNG
let seed=12345;function rnd(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;}
function gauss(){let u=0,v=0;while(!u)u=rnd();v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
const sc=Object.assign({},D.scen[scn]);if(process.env.TW)sc.tw=+process.env.TW;
const mu={etf:sc.etf/100,tw:sc.tw/100,ko:sc.ko/100}, sd={etf:0.20,tw:0.25,ko:0.18};
const C=[[1,0.6,0.3],[0.6,1,0.2],[0.3,0.2,1]];
// cholesky
const L=[[0,0,0],[0,0,0],[0,0,0]];for(let i=0;i<3;i++)for(let j=0;j<=i;j++){let s=C[i][j];for(let k=0;k<j;k++)s-=L[i][k]*L[j][k];L[i][j]=i==j?Math.sqrt(s):s/L[j][j];}
const keys=["etf","tw","ko"];
function path(){const p=[];for(let y=0;y<30;y++){const z=[gauss(),gauss(),gauss()];const o={};keys.forEach((k,i)=>{let e=0;for(let j=0;j<=i;j++)e+=L[i][j]*z[j];const s2=sd[k]**2;const m=Math.log(1+mu[k])-s2/2;o[k]=(Math.exp(m+sd[k]*e)-1)*100;});p.push(o);}return p;}
const paths=[];for(let i=0;i<N;i++)paths.push(path());
const base=["2887","etf","ko"];
const poolVal=(c,p)=>p==="etf"?c.v["0050"]+c.v["006208"]:p==="2887"?c.v["2887"]:c.v["KO"];
const retOf=(c,p)=>c.prev?(p==="etf"?c.prev.etf:p==="2887"?c.prev.tw:c.prev.ko):0;
const S={
 "A 固定:2887→ETF→KO":{order:[...base,"res"]},
 "B 固定:ETF→2887→KO":{order:["etf","2887","ko","res"]},
 "C 三池同比例":{order:"prorata"},
 "D 再平衡:先賣超重者":{order:c=>{const tot=base.reduce((a,p)=>a+poolVal(c,p),0);const ini={etf:c.init["0050"]+c.init["006208"],"2887":c.init["2887"],ko:c.init["KO"]};const it=Object.values(ini).reduce((a,b)=>a+b,0);return [...base].sort((a,b)=>(poolVal(c,b)/tot)/(ini[b]/it)-(poolVal(c,a)/tot)/(ini[a]/it)).concat("res");}},
 "E GK式:先賣去年漲最多,跌的最後":{order:c=>c.prev?[...base].sort((a,b)=>retOf(c,b)-retOf(c,a)).concat("res"):[...base,"res"]},
 "F 低報酬先賣,但去年跌的延後":{order:c=>{const up=base.filter(p=>retOf(c,p)>=0),dn=base.filter(p=>retOf(c,p)<0);return up.concat(dn,"res");}},
 "G 上限1×報酬後換下一個":{order:[...base,"res"],capMult:1},
};
const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(p*(s.length-1))];};
for(const m of targets){console.log(`\n=== ${scn} 均值 | 月目標 ${m} 萬 | ${N} 條路徑 ===`);
 for(const [n,o] of Object.entries(S)){let ok=0,nets=[],sf=[],fy=[];const t0=Date.now();
  for(const p of paths){const rows=M.run(Object.assign({},D,{scenario:sc,withdrawalMode:"target",livingTarget:m*12,years:30,pessimistic:false,pathReturns:p},o));
   const bad=rows.filter(r=>r.shortfall>0.05);if(!bad.length)ok++;fy.push(bad.length?bad[0].yr:31);nets.push(rows[29].net);sf.push(bad.reduce((a,r)=>a+r.shortfall,0));}
  console.log(n.padEnd(22),"成功率",(ok/N*100).toFixed(1).padStart(5)+"%","首缺口年中位",String(q(fy,0.5)).padStart(2),"P10首缺口",String(q(fy,0.1)).padStart(2),"淨值P10/P50",q(nets,0.1).toFixed(0).padStart(5),q(nets,0.5).toFixed(0).padStart(6),"平均缺口",(sf.reduce((a,b)=>a+b,0)/N).toFixed(0).padStart(5),((Date.now()-t0)/1000).toFixed(0)+"s");}}
