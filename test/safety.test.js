const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanCache, sanitizeSettings, safeExternal } = require('../src/safety');
const { CallNotifications } = require('../src/call-notifications');
test('cache cleanup never deletes persistent session storage', async () => {
  let cleared = false;
  const bytes = await cleanCache({ getCacheSize: async () => 2048, clearCache: async () => { cleared = true; }, clearStorageData: () => assert.fail('Must preserve login and databases') });
  assert.equal(bytes, 2048); assert.equal(cleared, true);
});
test('cache errors propagate', async () => { await assert.rejects(cleanCache({getCacheSize: async () => 2, clearCache: async () => { throw Error('disk'); }}), /disk/); });
test('only known settings with valid types survive', () => { assert.deepEqual(sanitizeSettings({autoStart:'yes', closeToTray:false, trayAppearance:'color', arbitrary:true}), {closeToTray:false,trayAppearance:'color'}); });
test('unsafe external protocols are rejected', () => { for (const url of ['file:///etc/passwd','javascript:alert(1)','not a url']) assert.equal(safeExternal(url),false); assert.equal(safeExternal('https://example.com'),true); });
test('closing calls invalidates pending notifications', () => { const n = new CallNotifications({ onAction() {}, onFailure() {} }); n.callId = 'old'; const version=n.generation; n.close(); assert.equal(n.callId,null); assert.equal(n.generation,version+1); });
