import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('all three professions retain the locked original game Sprites and role enum mapping',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url)));
  const lock=JSON.parse(await readFile(new URL('../public/data/asset-lock.json',import.meta.url)));
  assert.deepEqual(Object.keys(catalog.jobIcons),['1','2','4']);
  assert.equal(lock.jobIcons.length,3);
  assert.match(lock.jobAssetRef,/^[a-f0-9]{40}$/);
  for(const [jobId,job,spriteId] of [
    [1,'warrior','3315186087643974228'],
    [2,'sniper','-3166586490611880527'],
    [4,'sorcerer','323846835936649364'],
  ]){
    const asset=lock.jobIcons.find(item=>item.jobId===jobId);
    assert.ok(asset);
    assert.equal(asset.job,job);
    assert.equal(asset.sourceRef,lock.jobAssetRef);
    assert.equal(asset.path,`assets/ui/icon_job_${job}.png`);
    assert.equal(asset.sourcePath,asset.path);
    assert.equal(catalog.jobIcons[jobId],`./${asset.path}`);
    assert.ok(asset.sourceResourceKey.endsWith(`#Sprite:${spriteId}`));
    assert.equal(asset.width,50);
    assert.equal(asset.height,50);
    const bytes=await readFile(new URL(`../public/${asset.path}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
    assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(bytes.readUInt32BE(16),50);
    assert.equal(bytes.readUInt32BE(20),50);
  }
  assert.deepEqual([...new Set(catalog.characters.map(character=>character.job))].sort(),[1,2,4]);
});
