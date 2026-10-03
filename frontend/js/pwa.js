// Registro do service worker e aviso de nova versão.

import { toast } from './ui.js';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Nova versão disponível.', {
            duration: 0,
            action: { label: 'Atualizar', onClick: () => worker.postMessage('SKIP_WAITING') },
          });
        }
      });
    });
  }).catch(() => { /* PWA indisponível: o app continua funcionando online. */ });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) {
      reloading = true;
      location.reload();
    }
  });
}
