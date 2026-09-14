'use strict';
async function cleanCache(session) {
  const bytes = await session.getCacheSize();
  await session.clearCache();
  return bytes;
}
function sanitizeSettings(input) {
  const result = {};
  for (const key of ['minimizeToTray','closeToTray','showUnreadCountInTitle','enableNotifications','notificationSound','startMinimized','autoStart','pseudoSleep']) {
    if (typeof input?.[key] === 'boolean') result[key] = input[key];
  }
  if (['color','light','dark'].includes(input?.trayAppearance)) result.trayAppearance = input.trayAppearance;
  return result;
}
function safeExternal(url) {
  try { return ['https:','http:','mailto:'].includes(new URL(url).protocol); } catch (_) { return false; }
}
module.exports = { cleanCache, sanitizeSettings, safeExternal };
