import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('all six attribute badges use the locked original game Sprites with their exact bytes and element mapping',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url)));
  const lock=JSON.parse(await readFile(new URL('../public/data/asset-lock.json',import.meta.url)));
  const elements=['blue','red','green','yellow','light','dark'];
  assert.deepEqual(Object.keys(catalog.elementIcons),elements);
  assert.equal(lock.elementIcons.length,6);
  for(const [index,element] of elements.entries()){
    const asset=lock.elementIcons.find(item=>item.element===element);
    assert.ok(asset);
    assert.equal(asset.elementId,index+1);
    assert.equal(asset.sourcePath,`assets/ui/icon_element_${index+1}.png`);
    assert.equal(catalog.elementIcons[element],`./${asset.path}`);
    assert.match(asset.sourceResourceKey,/#Sprite:-?\d+$/);
    const bytes=await readFile(new URL(`../public/${asset.path}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
    assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(bytes.readUInt32BE(16),64);
    assert.equal(bytes.readUInt32BE(20),64);
  }
  const frame=lock.uiAssets.find(item=>item.id==='teamFrame');
  assert.equal(frame.sourcePath,'assets/ui/toggle_04_off.png');
  assert.equal(catalog.teamFrame,`./${frame.path}`);
  assert.match(frame.sourceResourceKey,/#Sprite:-?\d+$/);
  const frameBytes=await readFile(new URL(`../public/${frame.path}`,import.meta.url));
  assert.equal(createHash('sha256').update(frameBytes).digest('hex'),frame.sha256);
  assert.deepEqual([...frameBytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
});

test('rarity art preserves original nine-slice geometry, tint matrices and LR5 stars',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url)));
  const lock=JSON.parse(await readFile(new URL('../public/data/asset-lock.json',import.meta.url)));
  const art=catalog.iconArt;
  assert.deepEqual(art.characterRarities.SR,{frame:'common',tintMatrix:'0.977 0 0 0 0 0 0.863 0 0 0 0 0 0.587 0 0 0 0 0 1 0',starCount:0});
  assert.deepEqual(art.characterRarities.LR,{frame:'lr',tintMatrix:null,starCount:0});
  assert.deepEqual(art.characterRarities.LR5,{frame:'lr',tintMatrix:null,starCount:5});
  assert.deepEqual(art.characterGeometry,{canvasSize:154,sourceSize:62,sourceInsets:{left:25,top:26,right:25,bottom:25},targetInsets:{left:28,top:29,right:28,bottom:28},outward:3});
  assert.deepEqual(art.equipmentGeometry,{canvasSize:128,sourceSize:62,sourceInsets:{left:20,top:20,right:20,bottom:20},targetInsets:{left:20,top:20,right:20,bottom:20},outward:0});
  assert.equal(art.equipmentRarities.SSR.tintMatrix,'0.682353 0 0 0 0 0 0.407843 0 0 0 0 0 0.929412 0 0 0 0 0 1 0');
  assert.equal(art.equipmentRarities.UR.tintMatrix,'0.890196 0 0 0 0 0 0.333333 0 0 0 0 0 0.4 0 0 0 0 0 1 0');
  for (const [id,name,width,height,url] of [
    ['commonRarityFrame','frame_common_slice.png',62,62,art.frames.common],
    ['lrRarityFrame','frame_common_lr_slice.png',62,62,art.frames.lr],
    ['goldRarityStar','icon_rarity_plus_star_1.png',22,21,art.goldStar],
  ]) {
    const asset=lock.uiAssets.find(item=>item.id===id);
    assert.equal(asset.sourcePath,`assets/ui/${name}`);
    assert.equal(url,`./${asset.path}`);
    assert.match(asset.sourceResourceKey,/#Sprite:-?\d+$/);
    const bytes=await readFile(new URL(`../public/${asset.path}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
    assert.equal(bytes.readUInt32BE(16),width);
    assert.equal(bytes.readUInt32BE(20),height);
  }
});

test('equipment pictures resolve actual owner weapons and deduplicate shared armor across all jobs',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url)));
  const lock=JSON.parse(await readFile(new URL('../public/data/asset-lock.json',import.meta.url)));
  const armorIds={SSR:{2:184,3:182,4:180,5:181,6:183},UR:{2:192,3:190,4:188,5:189,6:191},LR:{2:200,3:198,4:196,5:197,6:199}};
  assert.deepEqual(Object.keys(catalog.iconArt.equipmentIcons),['1','2','4']);
  assert.equal(new Set(lock.equipmentAssets.map(asset=>asset.path)).size,lock.equipmentAssets.length);
  for (const asset of lock.equipmentAssets) {
    assert.equal(asset.sourcePath,`assets/equipment/EQP_${String(asset.iconId).padStart(6,'0')}.png`);
    assert.ok(asset.sourceResourceKey.endsWith(`/Icon/Equipment/EQP_${String(asset.iconId).padStart(6,'0')}.png`));
    const bytes=await readFile(new URL(`../public/${asset.path}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
    assert.equal(bytes.readUInt32BE(16),128);
    assert.equal(bytes.readUInt32BE(20),128);
  }
  for (const character of catalog.characters) {
    const asset=lock.equipmentAssets.find(item=>item.iconId===character.exclusiveWeaponIconId);
    assert.ok(asset,`missing real exclusive-weapon art for ${character.id}`);
    assert.equal(character.exclusiveWeaponIcon,`./${asset.path}`);
  }
  for (const job of [1,2,4]) {
    const representative=catalog.iconArt.representativeExclusiveWeapons[job];
    const character=catalog.characters.find(item=>item.id===representative.characterId);
    assert.equal(character.job,job);
    assert.equal(character.exclusiveWeaponIconId,representative.iconId);
    for (const [rarity,slots] of Object.entries(armorIds)) {
      assert.equal(catalog.iconArt.equipmentIcons[job][rarity][1],character.exclusiveWeaponIcon);
      for (const [slot,iconId] of Object.entries(slots)) assert.equal(catalog.iconArt.equipmentIcons[job][rarity][slot],`./assets/equipment/EQP_${String(iconId).padStart(6,'0')}.png`);
    }
  }
});
