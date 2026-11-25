/**
 * Service worker. Deliberately tiny: all video work happens inside the Meet
 * tab (a service worker has no DOM, no camera and no canvas, and is suspended
 * when idle — it cannot sit in a video path).
 *
 *   - seeds default settings on install
 *   - shows a per-tab badge while a Meet camera stream is being processed
 */
importScripts('shared/settings.js');

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(Object.keys(ShinobiSettings.DEFAULTS));
  const missing = {};
  for (const [key, value] of Object.entries(ShinobiSettings.DEFAULTS)) {
    if (stored[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'badge' || !sender.tab?.id) return;
  const tabId = sender.tab.id; // badge is per tab → multiple Meet tabs stay independent
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#1e90ff' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: message.active ? 'ON' : '' }).catch(() => {});
});
