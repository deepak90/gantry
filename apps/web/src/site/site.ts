/**
 * The public site's one script (landing, Privacy, Terms, Credits, 404):
 * - cookieless visit counts and page speed (hosted build only, see ../analytics.ts), filed under the page's route;
 * - a count of clicks on the calls to action and outbound links (`data-track` names the event, `data-track-place`
 *   says where on the page);
 * - the film: its poster links to YouTube, and with scripts on it plays in place, in YouTube's privacy-enhanced
 *   player. Nothing is fetched from YouTube until someone presses play.
 */
import { startAnalytics, track } from '../analytics';

startAnalytics(document.documentElement.dataset.route ?? location.pathname);

document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-track]') : null;
  if (link?.dataset.track) track(link.dataset.track, { place: link.dataset.trackPlace ?? null });
});

for (const poster of document.querySelectorAll<HTMLAnchorElement>('a[data-film-embed]')) {
  poster.addEventListener('click', (event) => {
    // A new tab or window (a modified or middle click) still goes to YouTube.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const player = document.createElement('iframe');
    player.className = 'film';
    player.src = `${poster.dataset.filmEmbed}?autoplay=1&rel=0&playsinline=1`;
    player.title = 'Gantry: the film';
    player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    player.allowFullscreen = true;
    player.referrerPolicy = 'strict-origin-when-cross-origin';
    poster.replaceWith(player);
    player.focus();
  });
}
