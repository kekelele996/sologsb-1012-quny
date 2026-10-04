import { defineCustomElements } from '@ionic/core/loader';
import { setupConfig } from '@ionic/core';

export default async function initializeIonic() {
  setupConfig({ mode: 'md', animated: true });
  await defineCustomElements(window);
}
