import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Agent Feedback',
    description: 'Comment on UI elements, capture screenshots and export feedback for coding agents.',
    permissions: ['storage', 'unlimitedStorage', 'downloads', 'tabs', 'activeTab', 'scripting', 'offscreen', 'clipboardWrite'],
    host_permissions: ['<all_urls>'],
    commands: {
      'toggle-picker': {
        suggested_key: { default: 'Alt+Shift+C' },
        description: 'Element kommentieren',
      },
    },
  },
});
