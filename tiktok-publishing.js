(() => {
  'use strict';

  const connect = document.getElementById('avTikTokConnect');
  const disconnect = document.getElementById('avTikTokDisconnect');
  const status = document.getElementById('avTikTokStatus');
  if (!connect || !disconnect || !status) return;

  async function call(action, payload = {}) {
    const config = window.SOCIALPILOT_SUPABASE;
    const session = await authClient?.auth.getSession();
    if (!session?.data.session) throw new Error('Sign in to Ariavora to connect TikTok.');
    const response = await fetch(config.url + '/functions/v1/tiktok-publishing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.publishableKey,
        Authorization: 'Bearer ' + session.data.session.access_token,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'TikTok is temporarily unavailable.');
    return result;
  }

  let connected = false;
  function show(result) {
    connected = Boolean(result.connected);
    document.querySelectorAll('[data-tiktok-publish]').forEach(button => { button.hidden = !connected; });
    connect.hidden = false;
    disconnect.hidden = !result.linked;
    connect.textContent = result.linked ? 'Reconnect TikTok' : 'Connect TikTok';
    status.textContent = result.connected ? 'TikTok connected for sandbox testing.'
      : result.linked ? 'TikTok authorization expired. Reconnect to continue.'
      : 'Connect an approved TikTok sandbox tester.';
  }

  connect.addEventListener('click', async () => {
    connect.disabled = true;
    try {
      const result = await call('start');
      sessionStorage.setItem('ariavora-tiktok-state', result.state);
      location.assign(result.url);
    } catch (error) {
      status.textContent = error.message;
      connect.disabled = false;
    }
  });

  disconnect.addEventListener('click', async () => {
    disconnect.disabled = true;
    try {
      await call('disconnect');
      show({ connected: false, linked: false });
    } catch (error) {
      status.textContent = error.message;
    } finally {
      disconnect.disabled = false;
    }
  });

  const dialog = document.getElementById('avTikTokDialog');
  const form = document.getElementById('avTikTokForm');
  const preview = document.getElementById('avTikTokPreview');
  const submit = document.getElementById('avTikTokSubmit');
  const close = document.getElementById('avTikTokClose');
  const checkPost = document.getElementById('avTikTokCheck');
  const publishStatus = document.getElementById('avTikTokPublishStatus');
  const creatorLabel = document.getElementById('avTikTokCreator');
  let job, creator, publishId, busy = false;

  window.addEventListener('av:tiktok-controls', event => { event.detail.hidden = !connected; });
  window.addEventListener('av:tiktok-publish', async event => {
    if (!connected || dialog.open) return;
    job = event.detail;
    creator = null;
    publishId = null;
    form.reset();
    checkPost.hidden = true;
    submit.disabled = true;
    creatorLabel.textContent = '';
    publishStatus.textContent = 'Checking your TikTok account…';
    preview.src = job.video_url;
    dialog.showModal();
    const activeJob = job;
    try {
      const account = await call('creator');
      if (job !== activeJob || !dialog.open) return;
      creator = account;
      creatorLabel.textContent = account.nickname + ' (@' + account.username + ')';
      publishStatus.textContent = '';
      submit.disabled = false;
    } catch (error) {
      publishStatus.textContent = error.message;
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!creator || busy || publishId) return;
    if (!Number.isFinite(preview.duration) || preview.duration > creator.maxDuration) {
      publishStatus.textContent = 'Wait for the preview to load. TikTok allows up to ' + creator.maxDuration + ' seconds for this account.';
      return;
    }
    const fields = new FormData(form);
    busy = true;
    close.disabled = true;
    submit.disabled = true;
    publishStatus.textContent = 'Sending the video to TikTok…';
    try {
      const result = await call('publish', {
        id: job.id, username: creator.username, caption: fields.get('caption'),
        privacy: fields.get('privacy'), consent: fields.has('consent'),
      });
      publishId = result.publishId;
      checkPost.hidden = false;
      publishStatus.textContent = result.uploaded ? 'Video sent. Check its processing status with TikTok.'
        : 'The transfer could not be confirmed. Check its status before trying again.';
    } catch (error) {
      publishStatus.textContent = error.message;
      submit.disabled = false;
    } finally {
      busy = false;
      close.disabled = false;
    }
  });

  checkPost.addEventListener('click', async () => {
    checkPost.disabled = true;
    try {
      const result = await call('publish-status', { publishId });
      const messages = {
        PUBLISH_COMPLETE: 'TikTok confirmed that your private video was published.',
        FAILED: 'TikTok reported that this post failed.',
        PROCESSING_UPLOAD: 'TikTok is waiting for or processing the upload.',
        PROCESSING_DOWNLOAD: 'TikTok is processing the video.',
      };
      publishStatus.textContent = messages[result.status] || 'TikTok is processing the request.';
    } catch (error) {
      publishStatus.textContent = error.message;
    } finally {
      checkPost.disabled = false;
    }
  });

  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    job = null;
    preview.removeAttribute('src');
    preview.load();
  });

  async function initialize() {
    try {
      const saved = sessionStorage.getItem('ariavora-tiktok-return');
      sessionStorage.removeItem('ariavora-tiktok-return');
      const result = saved ? JSON.parse(saved) : null;
      if (result) status.closest('details').open = true;
      if (result && !result.cancelled) await call('complete', result);
      show(await call('status'));
      if (result?.cancelled) status.textContent = 'TikTok authorization was cancelled or expired.';
    } catch (error) {
      status.textContent = error.message;
    }
  }

  let opened = false;
  function check() {
    if (location.hash !== '#ai-video-studio' || opened) return;
    opened = true;
    void initialize();
  }
  window.addEventListener('hashchange', check);
  check();
})();
