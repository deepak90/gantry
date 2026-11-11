/**
 * The hosted site's words for a visit, in one place. A visitor's copy of Harbor Street Offices is a "session" to them
 * (the code keeps calling it a copy: copy_pool, claimCopy). The site's pages take the main button's words from here
 * too (apps/web/src/site/site-config.ts), so changing them here changes them everywhere.
 */

/** The main button, on the welcome screen and every page of the site. */
export const START_SESSION = 'Start a session';

/** After a session was reset. */
export const START_NEW_SESSION = 'Start a new session';

/** The way in for someone who was given a code. */
export const JOIN_WITH_CODE = 'Join with a code';
