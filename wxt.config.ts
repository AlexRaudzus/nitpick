import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Nitpick',
    description: 'Comment on UI elements, capture screenshots and export feedback for coding agents.',
    permissions: ['storage', 'unlimitedStorage', 'downloads', 'tabs', 'activeTab', 'scripting', 'offscreen', 'clipboardWrite', 'contextMenus'],
    // No popup: a click on the icon starts the session / shows or hides the toolbar (see background).
    action: { default_title: 'Nitpick' },
    host_permissions: ['<all_urls>'],
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Session starten / Toolbar ein- und ausblenden',
      },
      'toggle-picker': {
        suggested_key: { default: 'Alt+Shift+C' },
        description: 'Element kommentieren',
      },
      export: {
        suggested_key: { default: 'Alt+Shift+E' },
        description: 'Exportieren (laufende Session: danach neue Session)',
      },
    },
  },
});
