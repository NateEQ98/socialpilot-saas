'use strict';

const response = new URLSearchParams(location.search);
history.replaceState(null, '', location.pathname);

try {
  const state = sessionStorage.getItem('ariavora-meta-state');
  sessionStorage.removeItem('ariavora-meta-state');
  sessionStorage.removeItem('ariavora-meta-return');

  if (state && response.get('state') === state) {
    const code = response.get('code');
    const result = code && !response.has('error')
      ? { code, state }
      : { cancelled: true };
    sessionStorage.setItem('ariavora-meta-return', JSON.stringify(result));
  }
} finally {
  location.replace('/?meta-return=1#ai-video-studio');
}
