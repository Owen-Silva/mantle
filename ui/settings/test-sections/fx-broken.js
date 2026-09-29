/* fx-broken.js — a FIXTURE (mock only): a module that throws while it loads. The sidebar must list
 * it as down with this reason, and the rest of Settings must work. */
throw new Error('fx-broken: made-up failure while loading');
