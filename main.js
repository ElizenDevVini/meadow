// Read live so devtools' reduced-motion emulation takes effect without a reload.
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');

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

// The entrance animation on .rv has fill:forwards, which pins opacity via
// the animation cascade layer, above the normal .gone{opacity:0} rule. Once
// it finishes, drop the animation so .gone's transition can take over.
cue.addEventListener('animationend', () => { cue.style.animation = 'none'; }, { once: true });

let ticking = false;
function onScroll() {
  if (motionQuery.matches) return;
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    const y = window.scrollY;
    const h = window.innerHeight;
    const p = Math.min(y / h, 1);
    const mediaY = y * 0.18;
    const copyY = y * 0.3;
    const opacity = Math.max(0, Math.min(1, 1 - p * 1.4));
    media.style.transform = 'translate3d(0, ' + mediaY + 'px, 0)';
    copy.style.transform = 'translate3d(0, ' + copyY + 'px, 0)';
    copy.style.opacity = String(opacity);
    cue.classList.toggle('gone', y > 40);
    ticking = false;
  });
}

function resetHero() {
  media.style.transform = '';
  copy.style.transform = '';
  copy.style.opacity = '';
  cue.classList.remove('gone');
}

// Toggling the emulated media query mid-session should react immediately,
// not wait for the next scroll tick.
motionQuery.addEventListener('change', () => {
  if (motionQuery.matches) resetHero();
  else onScroll();
});

// Attached unconditionally: onScroll's own motionQuery.matches check is what
// gates the work, so the listener stays live if reduced-motion is toggled
// off again later (devtools emulation, or an OS setting change mid-session).
addEventListener('scroll', onScroll, { passive: true });
onScroll();

const revealObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add('in');
      revealObserver.unobserve(e.target);
    }
  }
}, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });

document.querySelectorAll('[data-reveal]').forEach(el => {
  // Above-the-fold content shows at once so there's no flash of hidden
  // content; the observer only handles what scrolls in later.
  if (el.getBoundingClientRect().top < innerHeight) el.classList.add('in');
  else revealObserver.observe(el);
});
