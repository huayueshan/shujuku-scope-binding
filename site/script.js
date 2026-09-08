(() => {
  'use strict';
  const data = window.releaseData;
  if (data) {
    document.querySelectorAll('[data-version]').forEach(node => { node.textContent = `v${data.version}`; });
    const rows = document.querySelector('#compatibility-rows');
    rows.replaceChildren(...data.database.map(item => {
      const row = document.createElement('tr');
      for (const value of [item.tag, item.evidence === 'live-basic' ? '进行过基本测试和实机测试' : '进行过基本测试，没有进行实机测试']) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    }));
  }
  const contents = document.querySelector('.contents');
  const mobile = matchMedia('(max-width: 700px)');
  const syncMenu = () => { contents.open = !mobile.matches; };
  syncMenu();
  mobile.addEventListener('change', syncMenu);
  const links = [...document.querySelectorAll('.contents nav a')];
  links.forEach(link => link.addEventListener('click', () => { if (mobile.matches) contents.open = false; }));
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (!visible.length) return;
    links.forEach(link => {
      if (link.hash === `#${visible[0].target.id}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }, { rootMargin: '-80px 0px -60% 0px' });
  document.querySelectorAll('main > section').forEach(section => observer.observe(section));
})();
