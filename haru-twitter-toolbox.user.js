// ==UserScript==
// @name         haru twitter toolbox
// @namespace    local.x-share-links
// @version      1.0.0
// @description  Put Copy link, Copy link (fx), and Copy link (vx) first in X post share menus.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://www.x.com/*
// @match        https://www.twitter.com/*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const marker = 'data-x-share-links';
  const copyLabels = /^(Copy link(?: to (?:post|Tweet))?|复制链接|複製連結|复制推文链接|複製貼文連結|リンクをコピー)$/i;
  let context = null;
  const enhanced = new WeakSet();

  function postURL(value) {
    try {
      const url = new URL(value, location.href);
      if (!/^(?:www\.)?(?:x\.com|twitter\.com)$/.test(url.hostname)) return null;
      const match = url.pathname.match(/^\/(?:[\w]+\/status|i\/web\/status)\/(\d+)/);
      if (!match) return null;
      // Drop analytics/history suffixes; retain an explicit media selection.
      const media = url.pathname.slice(match[0].length).match(/^\/(?:video|photo)\/\d+/);
      return { id: match[1], url: `https://x.com${match[0]}${media ? media[0] : ''}` };
    } catch { return null; }
  }

  function resolvePost(button) {
    const article = button.closest('article');
    const group = button.closest('[role="group"]');
    // The action row's analytics link belongs to the outer post, not a quote.
    const analytics = group?.querySelector('a[href*="/status/"][href*="/analytics"]');
    let post = analytics && postURL(analytics.href);
    if (!post && article) {
      const links = [...article.querySelectorAll('a[href*="/status/"]')]
        .filter(a => a.closest('article') === article && !a.parentElement.closest('[role="link"]'));
      const own = links.find(a => a.querySelector('time'))
        || links.find(a => /\/(?:history|analytics)(?:\?|$)/.test(a.href));
      post = own && postURL(own.href);
    }
    const current = postURL(location.href);
    if (post && current?.id === post.id) return current.url;
    // Never fall back to the page URL for an unidentified timeline/reply article.
    return post?.url || (!article ? current?.url : null);
  }

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('[role="menu"]')) return;
    const button = target.closest('button, [role="button"]');
    context = button ? { url: resolvePost(button), button, time: Date.now() } : null;
  }, true);

  const style = document.createElement('style');
  style.textContent = `
    [${marker}="original"] { display: none !important; }
    [${marker}="item"]:hover, [${marker}="item"]:focus-visible {
      background-color: rgba(128,128,128,.14) !important;
      outline: none;
    }
  `;
  document.head.append(style);

  function notify(message) {
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.textContent = message;
    box.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1d9bf0;color:white;padding:12px 20px;border-radius:8px;font:14px system-ui;pointer-events:none';
    document.body.append(box);
    setTimeout(() => box.remove(), 2400);
  }

  async function copy(text) {
    if (typeof GM_setClipboard === 'function') {
      await new Promise((resolve, reject) => {
        try { GM_setClipboard(text, 'text', resolve); } catch (error) { reject(error); }
      });
    } else {
      await navigator.clipboard.writeText(text);
    }
  }

  function enhance(menu) {
    if (enhanced.has(menu)) return;
    const original = [...menu.querySelectorAll('[role="menuitem"]')]
      .find(item => copyLabels.test(item.textContent.trim()));
    if (!original || original.parentElement !== menu) return;
    const captured = context && Date.now() - context.time < 10000 ? context : null;
    if (!captured?.url) return;
    enhanced.add(menu);
    const fragment = document.createDocumentFragment();
    for (const [label, host] of [
      ['Copy link', null],
      ['Copy link (fx)', 'fxtwitter.com'],
      ['Copy link (vx)', 'vxtwitter.com'],
    ]) {
      // Cloning DOM copies the site's icon/layout, but not React click handlers.
      const item = original.cloneNode(true);
      item.setAttribute(marker, 'item');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-label', label);
      item.removeAttribute('id');
      item.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
      const text = [...item.querySelectorAll('span')].find(node => copyLabels.test(node.textContent.trim()));
      if (text) text.textContent = label;
      else item.textContent = label;
      const activate = async event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!host) { original.click(); return; }
        try {
          const url = new URL(captured.url);
          url.hostname = host;
          await copy(url.href);
          // Ask X to dismiss its own portal, avoiding manual removal of React DOM.
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
          if (menu.isConnected) {
            const backdrop = menu.parentElement?.firstElementChild;
            if (backdrop && backdrop !== menu && !backdrop.hasAttribute('role')
                && ['absolute', 'fixed'].includes(getComputedStyle(backdrop).position)) backdrop.click();
          }
          captured.button?.focus();
          notify(`Copied ${host} link`);
        } catch (error) {
          console.error('[X Share Links]', error);
          notify('Copy failed — please try again');
        }
      };
      item.addEventListener('click', activate);
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') activate(event);
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const rows = [...menu.querySelectorAll('[role="menuitem"]')].filter(row => row.getClientRects().length);
          const index = rows.indexOf(item);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
          rows[next]?.focus();
        }
      });
      fragment.append(item);
    }
    original.setAttribute(marker, 'original');
    menu.prepend(fragment);
  }

  let queued = false;
  const scan = () => {
    queued = false;
    document.querySelectorAll('[role="menu"]').forEach(enhance);
  };
  new MutationObserver(() => {
    if (!queued) { queued = true; queueMicrotask(scan); }
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
