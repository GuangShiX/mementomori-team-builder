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
