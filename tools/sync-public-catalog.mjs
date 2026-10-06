// Explicit maintenance task. Only the canonical, already public asset repository is read.
// Never copy game master books, accounts, or simulation implementation into this site.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
// Minimal display geometry and colors only; the private final renderer is never imported.
const equipmentComposition = {
  schemaVersion:1,
  canvasSize:128,
  layers:['plate','foreground','rarityFrame'],
  plate:{
    x:6,y:6,width:116,height:116,radius:14,
    palettes:{
      normal:{colors:['#a7a7a7','#717171','#454545'],middleOffset:0.56},
      holy:{colors:['#f0b36a','#c66b2c','#71371e'],middleOffset:0.52},
      dark:{colors:['#a184c5','#64408c','#302043'],middleOffset:0.52},
      both:{colors:['#a5e8ee','#479dc0','#304e85'],middleOffset:0.52},
    },
    light:{cx:0.46,cy:0.32,radius:0.42,color:'#ffffff',opacity:0.42},
    glow:{cx:0.70,cy:0.72,radius:0.48,color:'#ffffff',opacity:0.10},
  },
  foreground:{x:10,y:10,width:108,height:108,fit:'contain',shadow:{highlight:{dx:0,dy:1,blur:1,color:'#ffffff',opacity:0.24},depth:{dx:0,dy:4,blur:3,color:'#000000',opacity:0.50}}},
};
if (process.argv.includes('--display-only')) {
  const catalogPath = path.join(root,'public/data/catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath));
  if (catalog.iconArt?.schemaVersion !== 1) throw new Error('Unsupported original-art display contract.');
  catalog.iconArt.equipmentComposition = equipmentComposition;
  await writeFile(catalogPath,JSON.stringify(catalog,null,2)+'\n');
  console.log('Updated equipment composition display metadata; existing locked art and character catalog preserved.');
  process.exit(0);
}
const elementsOnly = process.argv.includes('--elements-only') || process.argv.includes('--ui-only');
const arcanaPortraitsOnly = process.argv.includes('--arcana-portraits-only');
const previousLock = elementsOnly || arcanaPortraitsOnly ? JSON.parse(await readFile(path.join(root, 'public/data/asset-lock.json'))) : null;
const ref = process.env.ASSET_REF || previousLock?.ref || '440e579724fa1fa11c737c308ef59266d41f0453';
if ((elementsOnly || arcanaPortraitsOnly) && ref !== previousLock.ref) throw new Error('Partial synchronization must use the existing locked asset ref.');
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
const index = arcanaPortraitsOnly ? {characters:[]} : JSON.parse(await fetchBytes('skills/index.json'));
const manifest = JSON.parse(await fetchBytes('manifest.json'));
function pngSize(bytes, name) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error(`Invalid original PNG: ${name}`);
  return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}
async function syncArt(category, name, expectedSize, identity = {}) {
  const asset = manifest.assets.find(item => item.category === category && item.name === name);
  const canonicalIdentity = category === 'ui'
    ? asset?.source_resource_key?.includes('#Sprite:')
    : asset?.source_resource_key?.endsWith(`/Icon/Equipment/${name}`);
  if (!asset?.sha256 || !canonicalIdentity) throw new Error(`Canonical original art missing: ${name}`);
  const bytes = await fetchBytes(asset.path, asset.sha256);
  const dimensions = pngSize(bytes, name);
  if (expectedSize && (dimensions.width !== expectedSize.width || dimensions.height !== expectedSize.height)) throw new Error(`Unexpected original art size: ${name}`);
  const target = `assets/${category}/${name}`;
  await mkdir(path.join(root, 'public', `assets/${category}`), {recursive:true});
  await writeFile(path.join(root, 'public', target), bytes);
  return {...identity,path:target,sha256:asset.sha256,sourcePath:asset.path,sourceResourceKey:asset.source_resource_key,...dimensions};
}
async function syncArcanaPortraits() {
  const ids = [2,3,4,12,13,14,22,23,24,32,33,34];
  const portraits = [];
  await mkdir(path.join(root,'public/assets/arcana-characters'),{recursive:true});
  for (const id of ids) {
    const stem = `CHR_${String(id).padStart(6,'0')}`;
    const name = `${stem}_00_s.png`;
    const asset = manifest.assets.find(item => item.category === 'characters' && item.name === name);
    if (!asset?.sha256 || asset.path !== `assets/characters/${name}`
      || !asset.source_resource_key?.endsWith(`/CharacterIcon/${stem}/${name}`)) throw new Error(`Canonical published arcana portrait missing: ${name}`);
    const bytes = await fetchBytes(asset.path,asset.sha256);
    const dimensions = pngSize(bytes,name);
    if (dimensions.width !== 128 || dimensions.height !== 128) throw new Error(`Invalid original arcana portrait size: ${name}`);
    const target = `assets/arcana-characters/${id}.png`;
    await writeFile(path.join(root,'public',target),bytes);
    portraits.push({id,path:target,sourcePath:asset.path,sha256:asset.sha256,sourceResourceKey:asset.source_resource_key});
  }
  return portraits;
}
const arcanaPortraits = await syncArcanaPortraits();
if (arcanaPortraitsOnly) {
  await writeFile(path.join(root,'public/data/asset-lock.json'),JSON.stringify({...previousLock,arcanaPortraits},null,2)+'\n');
  console.log(`Synced ${arcanaPortraits.length} original arcana-only portraits; SR catalog and existing art preserved.`);
  process.exit(0);
}
const elements = {1:'blue',2:'red',3:'green',4:'yellow',5:'light',6:'dark'};
const exclusiveWeaponNames = JSON.parse(await readFile(path.join(root, 'public/data/exclusive-weapon-names.json')));
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
const commonFrame = await syncArt('ui','frame_common_slice.png',{width:62,height:62},{id:'commonRarityFrame'});
const lrFrame = await syncArt('ui','frame_common_lr_slice.png',{width:62,height:62},{id:'lrRarityFrame'});
const goldStar = await syncArt('ui','icon_rarity_plus_star_1.png',{width:22,height:21},{id:'goldRarityStar'});
uiAssets.push(commonFrame,lrFrame,goldStar);
const entries = [];
const characters = [];
const publicProfiles = new Map();
for (const row of index.characters) {
  const data = JSON.parse(await fetchBytes(row.path, row.sha256));
  if (data.character.master_record.RarityFlags !== 8) continue;
  publicProfiles.set(row.id,{row,data});
  if (elementsOnly) continue;
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
  const exclusiveWeaponName = exclusiveWeaponNames[String(id)];
  if (!exclusiveWeaponName) throw new Error(`Public exclusive-weapon name missing: ${id}`);
  characters.push({id,name,subtitle:row.subtitles?.['zh-CN'] || '',element:elements[data.character.element_type],job:data.character.job_flags,baseRarity:8,portrait,exclusiveWeaponName});
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
const equipmentAssets = [];
const equipmentAssetByIconId = new Map();
async function equipmentIcon(iconId) {
  if (!Number.isSafeInteger(iconId) || iconId <= 0) throw new Error('Invalid public equipment icon ID.');
  if (!equipmentAssetByIconId.has(iconId)) {
    const asset = await syncArt('equipment',`EQP_${String(iconId).padStart(6,'0')}.png`,{width:128,height:128},{iconId});
    equipmentAssetByIconId.set(iconId,asset);
    equipmentAssets.push(asset);
  }
  return `./${equipmentAssetByIconId.get(iconId).path}`;
}
const representatives = {};
for (const character of catalog.characters) {
  const profile = publicProfiles.get(character.id);
  if (!profile || profile.data.character.job_flags !== character.job) throw new Error(`Locked public character profile missing: ${character.id}`);
  const iconId = profile.data.exclusive_weapon?.icon_id;
  if (!Number.isSafeInteger(iconId) || iconId <= 0) throw new Error(`Public exclusive-weapon icon missing: ${character.id}`);
  character.exclusiveWeaponIcon = await equipmentIcon(iconId);
  character.exclusiveWeaponIconId = iconId;
  representatives[character.job] ??= {characterId:character.id,iconId};
}
// Only the minimal visual mapping of the three published equipment series is kept.
// Ordinary armor is shared by all jobs; weapons always use a real exclusive-weapon icon.
const armorIcons = {SSR:{2:184,3:182,4:180,5:181,6:183},UR:{2:192,3:190,4:188,5:189,6:191},LR:{2:200,3:198,4:196,5:197,6:199}};
const equipmentIcons = {};
for (const job of [1,2,4]) {
  if (!representatives[job]) throw new Error(`No public exclusive-weapon representative for job ${job}.`);
  equipmentIcons[job] = {};
  for (const [rarity,slots] of Object.entries(armorIcons)) {
    equipmentIcons[job][rarity] = {1:await equipmentIcon(representatives[job].iconId)};
    for (const [slot,iconId] of Object.entries(slots)) equipmentIcons[job][rarity][slot] = await equipmentIcon(iconId);
  }
}
const diagonalTint = (r,g,b) => `${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 1 0`;
catalog.iconArt = {
  schemaVersion:1,
  frames:{common:`./${commonFrame.path}`,lr:`./${lrFrame.path}`},
  goldStar:`./${goldStar.path}`,
  characterRarities:{SR:{frame:'common',tintMatrix:diagonalTint('0.977','0.863','0.587'),starCount:0},LR:{frame:'lr',tintMatrix:null,starCount:0},LR5:{frame:'lr',tintMatrix:null,starCount:5}},
  equipmentRarities:{SSR:{frame:'common',tintMatrix:diagonalTint('0.682353','0.407843','0.929412'),starCount:0},UR:{frame:'common',tintMatrix:diagonalTint('0.890196','0.333333','0.4'),starCount:0},LR:{frame:'lr',tintMatrix:null,starCount:0}},
  characterGeometry:{canvasSize:154,sourceSize:62,sourceInsets:{left:25,top:26,right:25,bottom:25},targetInsets:{left:28,top:29,right:28,bottom:28},outward:3},
  equipmentGeometry:{canvasSize:128,sourceSize:62,sourceInsets:{left:20,top:20,right:20,bottom:20},targetInsets:{left:20,top:20,right:20,bottom:20},outward:0},
  equipmentComposition,
  characterStars:{canvasSize:154,x:23,y:127,step:21,width:23,height:22},
  equipmentIcons,
  representativeExclusiveWeapons:representatives,
};
await writeFile(path.join(root,'public/data/catalog.json'),JSON.stringify(catalog,null,2)+'\n');
await writeFile(path.join(root,'public/data/asset-lock.json'),JSON.stringify(elementsOnly ? {...previousLock,elementIcons:elementEntries,uiAssets,equipmentAssets,arcanaPortraits} : {ref,source:base,portraits:entries,elementIcons:elementEntries,uiAssets,equipmentAssets,arcanaPortraits},null,2)+'\n');
console.log(`Synced ${elementEntries.length} original element icons, ${uiAssets.length} UI Sprites, ${equipmentAssets.length} unique equipment icons and ${arcanaPortraits.length} arcana portraits; ${elementsOnly ? 'existing' : characters.length + ' public SR'} character catalog preserved.`);
