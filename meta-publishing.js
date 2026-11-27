'use strict';

(() => {
  const anchor = document.getElementById('avTikTokConnect')?.closest('details');
  const config = window.SOCIALPILOT_SUPABASE;
  if (!anchor || !config || typeof authClient === 'undefined' || !authClient) return;

  const panel = document.createElement('details');
  const heading = document.createElement('summary');
  heading.textContent = 'Facebook & Instagram';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const connect = document.createElement('button');
  connect.type = 'button';
  connect.className = 'spv-refresh';
  connect.textContent = 'Connect Facebook & Instagram';
  const disconnect = document.createElement('button');
  disconnect.type = 'button';
  disconnect.className = 'spv-refresh';
  disconnect.textContent = 'Disconnect from Ariavora';
  disconnect.hidden = true;
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'spv-refresh';
  check.textContent = 'Check publishing access';
  check.hidden = true;
  panel.append(heading, status, connect, disconnect, check);
  anchor.after(panel);

  async function call(session, action, fields = {}) {
    const response = await fetch(new URL('/functions/v1/meta-publishing', config.url), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + session.access_token,
        apikey: config.publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...fields }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'The Meta connection is temporarily unavailable.');
    return result;
  }

  function show(result, message) {
    disconnect.hidden = check.hidden = !result.connected;
    connect.textContent = result.connected ? 'Reconnect Facebook & Instagram' : 'Connect Facebook & Instagram';
    const destinations = (result.pages || []).map(page => page.instagram
      ? page.name + ' and @' + page.instagram
      : page.name);
    status.textContent = message || (result.connected
      ? 'Connected to ' + destinations.join(', ') + '.'
      : 'Connect a Facebook Page and its linked professional Instagram account.');
  }

  let active = false;
  let refreshPending = false;
  async function run(action, fields, message) {
    if (active) {
      if (action === 'status') refreshPending = true;
      return;
    }
    active = true;
    connect.disabled = disconnect.disabled = check.disabled = true;
    status.textContent = 'Checking the Meta connection…';
    try {
      const { data: { session } } = await authClient.auth.getSession();
      if (!session) {
        show({}, 'Sign in to Ariavora to connect Facebook and Instagram.');
        return;
      }
      const result = await call(session, action, fields);
      const { data: current } = await authClient.auth.getSession();
      if (current.session?.user.id !== session.user.id) {
        show({}, 'Your Ariavora session changed. Try again.');
        return;
      }
      if (action === 'start') {
        sessionStorage.setItem('ariavora-meta-state', result.state);
        location.assign(result.url);
        return;
      }
      const report = result.checks?.map(item => {
        const facebook = item.name + ' Facebook publishing permission ' + (item.facebook ? 'verified' : 'unverified');
        const instagram = item.instagram ? '@' + item.instagram + ' publishing quota access ' +
          (item.instagramPublishing ? 'verified' : 'unverified') : 'No linked Instagram account';
        return facebook + '. ' + instagram + '.';
      }).join(' ');
      show(result, report || message);
    } catch (error) {
      status.textContent = error.message || 'Could not check the Meta connection.';
    } finally {
      active = false;
      connect.disabled = disconnect.disabled = check.disabled = false;
      if (refreshPending && action !== 'start') {
        refreshPending = false;
        if (!disconnect.hidden || action === 'disconnect') void run('status');
      }
    }
  }

  connect.addEventListener('click', () => void run('start'));
  disconnect.addEventListener('click', () => void run('disconnect'));
  check.addEventListener('click', () => void run('check'));

  let returned;
  try {
    const saved = sessionStorage.getItem('ariavora-meta-return');
    sessionStorage.removeItem('ariavora-meta-return');
    if (saved) returned = JSON.parse(saved);
  } catch {
    // A blocked or invalid storage entry cannot complete authorization.
  }
  if (returned) panel.open = true;
  void (returned?.code
    ? run('complete', { code: returned.code, state: returned.state })
    : run('status', {}, returned?.cancelled ? 'Meta authorization was cancelled.' : undefined));
  authClient.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') {
      setTimeout(() => {
        if (event === 'SIGNED_OUT') show({}, 'Sign in to Ariavora to connect Facebook and Instagram.');
        else if (!active && !returned) void run('status');
      }, 0);
    }
  });
})();
