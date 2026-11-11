import 'webextension-polyfill';
import { exampleThemeStorage } from '@extension/storage';

exampleThemeStorage.get().then(theme => {
  console.log('theme', theme);
});

console.log('Background loaded');
console.log("Edit 'chrome-extension/src/background/index.ts' and save to reload.");

// Open the Receipts side panel when the toolbar icon is clicked.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
