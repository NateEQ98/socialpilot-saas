'use strict';
const response = new URLSearchParams(location.search);
history.replaceState(null, '', location.pathname);
try {
  const state = sessionStorage.getItem('ariavora-tiktok-state');
  sessionStorage.removeItem('ariavora-tiktok-state');
  const code = response.get('code');
  const result = state && response.get('state') === state && code && !response.has('error')
    ? { code, state }
    : { cancelled: true };
  sessionStorage.setItem('ariavora-tiktok-return', JSON.stringify(result));
} finally {
  location.replace('/#ai-video-studio');
}
