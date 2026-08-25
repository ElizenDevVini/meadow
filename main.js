const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

const nav = document.getElementById('nav');
const menu = document.getElementById('menu');
menu.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
});
document.getElementById('links').addEventListener('click', e => {
  if (e.target.tagName === 'A') {
    nav.classList.remove('open');
    menu.setAttribute('aria-expanded', 'false');
  }
});

const media = document.getElementById('media');
const copy = document.getElementById('copy');
const cue = document.getElementById('cue');
const video = media.querySelector('video');

if (reduce) {
  video.removeAttribute('autoplay');
  video.pause();
} else {
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      const h = window.innerHeight;
      const p = Math.min(y / h, 1);
      media.style.transform = 'translateY(' + (y * 0.18).toFixed(1) + 'px)';
      copy.style.transform = 'translateY(' + (y * 0.32).toFixed(1) + 'px)';
      copy.style.opacity = String(1 - p * 1.4);
      cue.classList.toggle('gone', y > 40);
      ticking = false;
    });
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

const io = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  }
}, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
document.querySelectorAll('[data-reveal]').forEach(el => io.observe(el));
