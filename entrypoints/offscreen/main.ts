// Offscreen document: the MV3 way to write to the clipboard without depending on page focus,
// secure context or user activation of whatever page the user is on.
import { browser } from 'wxt/browser';

browser.runtime.onMessage.addListener((msg: { type?: string; text?: string }, _sender, sendResponse) => {
  if (msg?.type !== 'offscreen:copy' || typeof msg.text !== 'string') return;
  const area = document.getElementById('clipboard') as HTMLTextAreaElement;
  area.value = msg.text;
  area.select();
  sendResponse(document.execCommand('copy'));
});
