// Accept only our fixed release grammar, never arbitrary refs or URLs.
export function selectVersion(versions, channel) {
  if (!['release', 'dev'].includes(channel)) throw new Error('Unknown channel');
  const candidates = (Array.isArray(versions) ? versions : []).flatMap(value => {
    if (typeof value !== 'string') return [];
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev\.(0|[1-9]\d*))?$/.exec(value);
    if (!match || (channel === 'dev') !== (match[4] !== undefined)) return [];
    const numbers = match.slice(1).map(x => Number(x ?? 0));
    if (!numbers.every(Number.isSafeInteger)) return [];
    return [{ value, numbers }];
  });
  candidates.sort((a, b) => {
    for (let i = 0; i < a.numbers.length; i++) {
      if (a.numbers[i] !== b.numbers[i]) return b.numbers[i] - a.numbers[i];
    }
    return a.value.localeCompare(b.value);
  });
  if (!candidates.length) throw new Error('No ' + channel + ' version available');
  return candidates[0].value;
}

export function createOnlineLoader(channel, notice = '') {
  if (!['release', 'dev'].includes(channel)) throw new Error('Unknown channel');
  return `/*\n${notice}*/\nawait (async () => {
  const channel = ${JSON.stringify(channel)};
  const repository = 'huayueshan/shujuku-scope-binding';
  const selectVersion = ${selectVersion.toString()};
  const cacheKey = 'sjbp-version-v1:' + channel;
  const ttl = 10 * 60 * 1000;
  let moduleUrl;
  try {
    const request = async (url, cache = 'default') => {
      const response = await fetch(url, {
        cache, signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response;
    };
    let cached;
    try { cached = JSON.parse(localStorage.getItem(cacheKey)); } catch (_) {}
    const now = Date.now();
    let version;
    if (cached && Number.isFinite(cached.checkedAt) && now >= cached.checkedAt && now - cached.checkedAt < ttl) {
      try { version = selectVersion([cached.version], channel); } catch (_) {}
    }
    if (!version) {
      const listing = await (await request('https://data.jsdelivr.com/v1/package/gh/' + repository + '?t=' + now, 'no-store')).json();
      version = selectVersion(listing.versions, channel);
    }
    const base = 'https://cdn.jsdelivr.net/gh/' + repository + '@' + version + '/dist/';
    const manifest = await (await request(base + 'manifest.json')).json();
    if (String(manifest.version).replace(/^v/, '') !== version.replace(/^v/, '')) throw new Error('Version manifest mismatch');
    const expected = manifest.files?.['index.js']?.sha256;
    if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Invalid manifest hash');
    const source = await (await request(base + 'index.js')).text();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    const actual = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) throw new Error('CDN version mismatch; reload to retry');
    moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    await import(moduleUrl);
    // Reloading within the TTL must not extend the cache lifetime.
    if (!cached || cached.version !== version || !Number.isFinite(cached.checkedAt) || now < cached.checkedAt || now - cached.checkedAt >= ttl) {
      try { localStorage.setItem(cacheKey, JSON.stringify({ version, checkedAt: now })); } catch (_) {}
    }
  } catch (error) {
    toastr.error('在线脚本加载失败：' + (error?.message || error), '数据库三层绑定');
    throw error;
  } finally {
    if (moduleUrl) URL.revokeObjectURL(moduleUrl);
  }
})();\n`;
}
