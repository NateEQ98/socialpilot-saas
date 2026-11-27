'use strict';

(() => {
  const form = document.createElement('form');
  const dialog = document.createElement('dialog');
  dialog.className = 'av-instagram-draft';
  dialog.setAttribute('aria-label', 'Publish a Reel');
  const title = document.createElement('h2');
  title.textContent = 'Publish a Reel';
  const preview = document.createElement('video');
  preview.controls = true;
  preview.playsInline = true;
  preview.preload = 'metadata';
  preview.style.cssText = 'display:block;max-width:100%;max-height:35vh;margin:auto';
  const targets = document.createElement('select');
  targets.required = true;
  targets.setAttribute('aria-label', 'Publishing destination');
  const caption = document.createElement('textarea');
  caption.maxLength = 2200;
  caption.placeholder = 'Caption (optional)';
  caption.setAttribute('aria-label', 'Caption');
  const consentLabel = document.createElement('label');
  const consent = document.createElement('input');
  consent.type = 'checkbox';
  consent.required = true;
  consentLabel.append(consent, ' Publish this video publicly on the selected account.');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');

  function button(text, type = 'button') {
    const element = document.createElement('button');
    element.type = type;
    element.className = 'spv-refresh';
    element.textContent = text;
    return element;
  }

  const publish = button('Publish Reel', 'submit');
  const check = button('Check Reel status');
  const close = button('Close');
  form.append(title, preview, targets, caption, consentLabel, status, publish, check, close);
  dialog.append(form);
  document.body.append(dialog);

  let activeVideo;
  let activeUserId;
  let busy = false;

  async function call(action, fields = {}) {
    const { data: { session } } = await authClient.auth.getSession();
    if (!session || session.user.id !== activeUserId) throw Error('Sign in to Ariavora again.');
    const config = window.SOCIALPILOT_SUPABASE;
    const response = await fetch(new URL('/functions/v1/meta-publishing', config.url), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + session.access_token,
        apikey: config.publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...fields }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw Error(result?.error || 'Could not reach Meta. Check the Reel status before trying again.');
    return result;
  }

  async function open(video) {
    if (busy || dialog.open) return;
    const { data: { session } } = await authClient.auth.getSession();
    if (busy || dialog.open) return;
    activeUserId = session?.user.id;
    activeVideo = video;
    form.reset();
    preview.src = video.video_url;
    targets.replaceChildren(new Option('Choose a destination', ''));
    status.textContent = 'Loading connected accounts…';
    publish.disabled = check.disabled = close.disabled = busy = true;
    dialog.showModal();
    try {
      const result = await call('status');
      for (const page of result.pages || []) {
        targets.add(new Option('Facebook · ' + page.name, 'facebook:' + page.id));
        if (page.instagram) targets.add(new Option('Instagram · @' + page.instagram, 'instagram:' + page.id));
      }
      status.textContent = result.connected ? 'Choose where to publish this Reel.'
        : 'Connect Facebook and Instagram in AI Video Studio first.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      publish.disabled = check.disabled = close.disabled = busy = false;
    }
  }

  async function send(action) {
    if (busy) return;
    if (!targets.value) {
      targets.reportValidity();
      return;
    }
    const [platform, pageId] = targets.value.split(':');
    const fields = { platform, pageId, videoId: activeVideo.id };
    if (action === 'publish-reel') Object.assign(fields, { caption: caption.value, confirm: consent.checked });
    busy = publish.disabled = check.disabled = close.disabled = targets.disabled = true;
    status.textContent = 'Contacting Meta…';
    try {
      const result = await call(action, fields);
      const messages = {
        new: 'This video has not been submitted to this destination.',
        processing: 'Instagram is processing the video. Use Check Reel status to finish the submission when it is ready.',
        sending: 'This submission has already started. Check the destination before trying again.',
        submitted: 'Meta accepted the Reel. Check the destination to confirm it appears.',
        failed: 'Meta reported that this submission failed. Check the destination for details.',
      };
      status.textContent = messages[result.state] || 'Check the destination for the latest status.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = publish.disabled = check.disabled = close.disabled = targets.disabled = false;
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    void send('publish-reel');
  });
  check.addEventListener('click', () => void send('reel-status'));
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    preview.removeAttribute('src');
    preview.load();
  });

  window.addEventListener('av:meta-reel-control', ({ detail: { card, video } }) => {
    if (video.aspect_ratio !== '9:16' || !video.id) return;
    const control = button('Publish Reel…');
    control.addEventListener('click', () => void open(video));
    card.append(control);
  });
})();
