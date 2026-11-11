// ==UserScript==
// @name         haru twitter toolbox
// @namespace    local.x-share-links
// @version      1.2.1
// @description  Download post media, restore native image context menus, and copy clean original/fx/vx links on X.
// @homepageURL  https://github.com/Antonoko/haru-twitter-toolbox
// @downloadURL  https://raw.githubusercontent.com/Antonoko/haru-twitter-toolbox/main/haru-twitter-toolbox.user.js
// @updateURL    https://raw.githubusercontent.com/Antonoko/haru-twitter-toolbox/main/haru-twitter-toolbox.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://www.x.com/*
// @match        https://www.twitter.com/*
// @grant        GM_setClipboard
// @grant        GM_download
// @connect      pbs.twimg.com
// @connect      video.twimg.com
// @sandbox      raw
// @run-at       document-start
// ==/UserScript==

(async () => {
  'use strict';

  // Disable only X's image-menu callback. Do not cancel or stop the event:
  // CrxMouse handles its macOS/Linux double-right-click on document's bubble phase.
  document.addEventListener('contextmenu', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const image = target.closest('img');
    if (!target.closest('[data-testid="tweetPhoto"]')
        && !(image && /^https:\/\/pbs\.twimg\.com\/media\//.test(image.currentSrc || image.src))) return;
    // Read the current props on every right click, including after React rerenders.
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      const key = Object.keys(node).find(key => key.startsWith('__reactProps$'));
      const props = key && node[key];
      if (typeof props?.onContextMenu === 'function') {
        props.onContextMenu = undefined;
        break;
      }
    }
  }, true);

  // The early context-menu hook must also work before head/body exist.
  if (document.readyState === 'loading') {
    await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }

  const marker = 'data-x-share-links';
  const copyLabels = /^(Copy link(?: to (?:post|Tweet))?|复制链接|複製連結|复制推文链接|複製貼文連結|リンクをコピー)$/i;
  let context = null;
  const enhanced = new WeakMap();
  const activeDownloads = new Set();

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
    [data-testid="tweetPhoto"] img, img[src^="https://pbs.twimg.com/media/"] {
      pointer-events: auto !important;
    }
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

  function postMedia(captured) {
    const id = postURL(captured.url).id;
    const button = captured.button;
    const key = Object.keys(button).find(key => key.startsWith('__reactFiber$'));
    // Match the post ID rather than walking nested quoted-post media or thumbnails.
    for (let fiber = key && button[key]; fiber; fiber = fiber.return) {
      const tweet = fiber.memoizedProps?.tweet;
      if (tweet?.id_str === id) {
        return tweet.extended_entities?.media || tweet.entities?.media || [];
      }
    }
    throw new Error('Cannot read media. Open the post and try again.');
  }

  function mediaFile(media) {
    if (media.type === 'photo') {
      const url = new URL(media.media_url_https);
      if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' || !url.pathname.startsWith('/media/')) return null;
      const extension = url.pathname.match(/\.(jpg|jpeg|png|webp)$/i)?.[1]?.toLowerCase()
        || url.searchParams.get('format') || 'jpg';
      if (!/^(jpg|jpeg|png|webp)$/.test(extension)) return null;
      url.pathname = url.pathname.replace(/\.(jpg|jpeg|png|webp)$/i, '');
      url.search = '';
      url.searchParams.set('format', extension);
      url.searchParams.set('name', 'orig');
      return { url: url.href, extension };
    }
    if (media.type === 'video' || media.type === 'animated_gif') {
      const variants = (media.video_info?.variants || []).filter(variant => {
        if (variant.content_type !== 'video/mp4') return false;
        const url = new URL(variant.url);
        return url.protocol === 'https:' && url.hostname === 'video.twimg.com' && url.pathname.endsWith('.mp4');
      });
      variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (variants[0]) return { url: variants[0].url, extension: 'mp4' };
    }
    return null;
  }

  function downloadFile(file, name) {
    return new Promise((resolve, reject) => {
      GM_download({
        url: file.url, name, saveAs: false,
        onload: resolve,
        onerror: error => reject(new Error(error?.error || 'Download failed')),
        ontimeout: () => reject(new Error('Download timed out')),
      });
    });
  }

  async function downloadMedia(captured, media) {
    const id = postURL(captured.url).id;
    if (activeDownloads.has(id)) { notify('This post is already downloading'); return; }
    if (!media.length) { notify('This post has no downloadable media'); return; }
    if (typeof GM_download !== 'function') throw new Error('Update the script and allow Tampermonkey downloads.');
    activeDownloads.add(id);
    let completed = 0;
    try {
      for (const [index, entry] of media.entries()) {
        notify(`Downloading media ${index + 1}/${media.length}…`);
        try {
          const file = mediaFile(entry);
          if (!file) throw new Error('No direct image or MP4 available');
          await downloadFile(file, `x_${id}_${index + 1}.${file.extension}`);
          completed++;
        } catch (error) {
          console.error('[X Media Download]', error);
        }
      }
      notify(completed === media.length ? `Downloaded ${completed} media file(s)`
        : `Downloaded ${completed}/${media.length}. Some media failed or are unavailable; check Tampermonkey download permissions.`);
    } finally {
      activeDownloads.delete(id);
    }
  }

  function dismissMenu(menu, button) {
    // Ask X to dismiss its own portal, avoiding manual removal of React DOM.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    if (menu.isConnected) {
      const backdrop = menu.parentElement?.firstElementChild;
      if (backdrop && backdrop !== menu && !backdrop.hasAttribute('role')
          && ['absolute', 'fixed'].includes(getComputedStyle(backdrop).position)) backdrop.click();
    }
    button?.focus();
  }

  function enhance(menu) {
    const originals = [...menu.querySelectorAll('[role="menuitem"]')]
      .filter(item => item.getAttribute(marker) !== 'item'
        && item.parentElement === menu && copyLabels.test(item.textContent.trim()));
    const original = originals[0];
    if (!original) return;
    const captured = enhanced.get(menu)
      || (context && Date.now() - context.time < 10000 ? context : null);
    if (!captured?.url) return;
    // X may replace its copy row after opening the menu. Hide new copies too.
    originals.forEach(item => item.setAttribute(marker, 'original'));
    if (menu.querySelector(`[${marker}="item"]`)) return;
    enhanced.set(menu, captured);
    const fragment = document.createDocumentFragment();
    for (const [label, host] of [
      ['Copy link', null],
      ['Copy link (fx)', 'fxtwitter.com'],
      ['Copy link (vx)', 'vxtwitter.com'],
      ['Download media', 'download'],
    ]) {
      // Cloning DOM copies the site's icon/layout, but not React click handlers.
      const item = original.cloneNode(true);
      if (host === 'download') {
        const icon = item.querySelector('svg');
        if (icon) {
          icon.setAttribute('viewBox', '0 0 24 24');
          icon.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', 'M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5');
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', 'currentColor');
          path.setAttribute('stroke-width', '2');
          path.setAttribute('stroke-linecap', 'round');
          path.setAttribute('stroke-linejoin', 'round');
          icon.replaceChildren(path);
        }
      }
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
        try {
          if (host === 'download') {
            const media = postMedia(captured);
            dismissMenu(menu, captured.button);
            await downloadMedia(captured, media);
            return;
          }
          const url = new URL(captured.url);
          if (host) url.hostname = host;
          url.search = '';
          url.hash = '';
          await copy(url.href);
          dismissMenu(menu, captured.button);
          notify(`Copied ${host || 'x.com'} link`);
        } catch (error) {
          console.error('[X Share Links]', error);
          notify(host === 'download' ? error.message : 'Copy failed — please try again');
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
