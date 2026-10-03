// Registro do service worker e aviso de nova versão.

import { toast } from './ui.js';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Recarrega só quando o usuário pediu a atualização. Na primeira visita o service worker
  // também assume o controle (clients.claim) e recarregar ali apagaria o que está sendo digitado.
  let updateRequested = false;

  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Nova versão disponível.', {
            duration: 0,
            action: { label: 'Atualizar', onClick: () => { updateRequested = true; worker.postMessage('SKIP_WAITING'); } },
          });
        }
      });
    });
  }).catch(() => { /* PWA indisponível: o app continua funcionando online. */ });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) {
      updateRequested = false;
      location.reload();
    }
  });
}
