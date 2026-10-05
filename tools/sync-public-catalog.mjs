// Explicit maintenance task. Only the canonical, already public asset repository is read.
// Never copy game master books, accounts, or simulation implementation into this site.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const elementsOnly = process.argv.includes('--elements-only') || process.argv.includes('--ui-only');
const previousLock = elementsOnly ? JSON.parse(await readFile(path.join(root, 'public/data/asset-lock.json'))) : null;
const ref = process.env.ASSET_REF || previousLock?.ref || '440e579724fa1fa11c737c308ef59266d41f0453';
if (elementsOnly && ref !== previousLock.ref) throw new Error('Element-only synchronization must use the existing locked asset ref.');
const base = `https://raw.githubusercontent.com/GuangShiX/mmtm-assets-fallback/${ref}`;
const cache = process.env.PUBLIC_ASSET_CACHE;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fetchBytes(relative, hash) {
  if (cache && hash) {
    try { const bytes = await readFile(path.join(cache, relative)); if (!hash || sha(bytes) === hash) return bytes; } catch {}
  }
  const response = await fetch(`${base}/${relative}`);
  if (!response.ok) throw new Error(`${relative}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash && sha(bytes) !== hash) throw new Error(`${relative}: canonical SHA-256 mismatch`);
  return bytes;
}
const index = elementsOnly ? { characters: [] } : JSON.parse(await fetchBytes('skills/index.json'));
const manifest = JSON.parse(await fetchBytes('manifest.json'));
const elements = {1:'blue',2:'red',3:'green',4:'yellow',5:'light',6:'dark'};
const elementEntries = [];
const elementIcons = {};
for (const [elementId, element] of Object.entries(elements)) {
  const name = `icon_element_${elementId}.png`;
  const asset = manifest.assets.find(item => item.category === 'ui' && item.name === name);
  if (!asset?.sha256 || !asset.source_resource_key?.includes('#Sprite:')) throw new Error(`Canonical game Sprite missing: ${name}`);
  const bytes = await fetchBytes(asset.path, asset.sha256);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    || bytes.readUInt32BE(16) !== 64 || bytes.readUInt32BE(20) !== 64) throw new Error(`Invalid original element icon: ${name}`);
  const target = `assets/ui/${name}`;
  await mkdir(path.join(root, 'public/assets/ui'), {recursive:true});
  await writeFile(path.join(root, 'public', target), bytes);
  elementIcons[element] = `./${target}`;
  elementEntries.push({element, elementId:Number(elementId), path:target, sha256:asset.sha256, sourcePath:asset.path, sourceResourceKey:asset.source_resource_key});
}
const frame = manifest.assets.find(item => item.category === 'ui' && item.name === 'toggle_04_off.png');
if (!frame?.sha256 || !frame.source_resource_key?.includes('#Sprite:')) throw new Error('Canonical game team frame Sprite missing.');
const frameBytes = await fetchBytes(frame.path, frame.sha256);
if (frameBytes.length < 24 || !frameBytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid original game team frame.');
const framePath = 'assets/ui/toggle_04_off.png';
await writeFile(path.join(root, 'public', framePath), frameBytes);
const uiAssets = [{id:'teamFrame',path:framePath,sha256:frame.sha256,sourcePath:frame.path,sourceResourceKey:frame.source_resource_key}];
const entries = [];
const characters = [];
for (const row of index.characters) {
  const data = JSON.parse(await fetchBytes(row.path, row.sha256));
  if (data.character.master_record.RarityFlags !== 8) continue;
  const id = row.id;
  const name = row.display_name;
  const sourceName = `CHR_${String(id).padStart(6,'0')}_00_s.png`;
  const asset = manifest.assets.find(a => a.category === 'characters' && a.name === sourceName);
  let portrait = null;
  if (asset) {
    const bytes = await fetchBytes(asset.path, asset.sha256);
    const target = `assets/characters/${id}.png`;
    await mkdir(path.join(root, 'public/assets/characters'), {recursive:true});
    await writeFile(path.join(root, 'public', target), bytes);
    portrait = `./${target}`;
    entries.push({id,path:target,sha256:asset.sha256,sourcePath:asset.path});
  }
  characters.push({id,name,subtitle:row.subtitles?.['zh-CN'] || '',element:elements[data.character.element_type],job:data.character.job_flags,baseRarity:8,portrait});
}
const levelsSSR = [180,200,220,240,...Array.from({length:21},(_,i)=>250+i*10)];
const levelsUR = Array.from({length:22},(_,i)=>240+i*10);
const curve = (levels, costs) => Object.fromEntries(levels.map((level,i)=>[level,costs[i]]));
const thresholds = [[61,20],[81,25],[101,33],[121,42],[141,54],[161,69],[181,89],[201,115],[221,150],...Array.from({length:21},(_,i)=>[241+10*i,152+2*i])];
const medicine = Array.from({length:451},(_,level)=>thresholds.reduce((total,[threshold,cost])=>total+(level>=threshold?cost:0),0));
const catalog = elementsOnly ? JSON.parse(await readFile(path.join(root, 'public/data/catalog.json'))) : {
  version: '450-public-v1', characterAssetRef:ref, characters,
  runeCategories: ['力量','战技','魔力','攻击','物魔防御穿透','命中','暴击','弱化效果命中','速度','耐力','生命','物理防御','魔法防御','闪避','暴击抗性','弱化效果抗性'].map((name,index)=>({id:index+1,name,ticketBased:[5,9].includes(index+1),slots:index<9?[1,2,3]:[4,5,6]})),
  equipmentSeries:[{id:12,name:'撒旦',rarities:['SSR'],costResource:'ssrFragments'},{id:13,name:'米迦勒',rarities:['UR'],costResource:'urLrFragments'},{id:14,name:'梅塔特隆',rarities:['LR'],costResource:'urLrFragments'}],
  equipmentCosts:{
    reinforcement:{weapon:medicine.map(x=>x*2),other:medicine},
    sacredExperience:Array.from({length:41},(_,level)=>level===0?0:1+level*(level-1)/2),
    fragments:{
      SSR:curve(levelsSSR,[75,85,95,105,120,135,155,175,195,220,245,270,295,325,355,385,415,445,475,505,535,565,595,625,655]),
      UR:curve(levelsUR,[100,115,130,150,170,190,215,240,265,290,320,350,380,410,440,470,500,530,560,590,620,650]),
      LR:curve(levelsUR,[100,115,130,150,170,190,215,240,265,290,320,350,380,410,440,470,500,530,560,590,620,650]),
      exclusiveSSR:curve([180,200,220,240],[80,130,195,275]),
      exclusiveUR:curve(levelsUR,[275,290,305,320,340,360,380,410,440,470,510,550,590,630,670,710,750,790,830,870,910,950]),
      exclusiveLR:curve(levelsUR,[275,290,305,320,340,360,380,410,440,470,510,550,590,630,670,710,750,790,830,870,910,950]),
    },
    allowedLevels:{SSR:levelsSSR,UR:levelsUR,LR:levelsUR},
  },
};
catalog.elementIcons = elementIcons;
catalog.teamFrame = `./${framePath}`;
await writeFile(path.join(root,'public/data/catalog.json'),JSON.stringify(catalog,null,2)+'\n');
await writeFile(path.join(root,'public/data/asset-lock.json'),JSON.stringify(elementsOnly ? {...previousLock,elementIcons:elementEntries,uiAssets} : {ref,source:base,portraits:entries,elementIcons:elementEntries,uiAssets},null,2)+'\n');
console.log(elementsOnly ? `Synced ${elementEntries.length} verified original element icons and game team frame; character catalog preserved.` : `Synced ${characters.length} public SR characters, ${entries.length} verified portraits, ${elementEntries.length} original element icons and game team frame.`);
