'use strict';
/*
 * _example.js - the main half of ui/settings/sections/_example.js (ui/settings/SECTIONS.md). Files
 * starting with _ are NOT loaded: copy it to <your-id>.js to start a real section.
 *
 * Each command is registered as settings.<id>.<name>: here settings.example.get and
 * settings.example.setGlow. A command gets (args, env) and returns a result object; a throw becomes
 * { ok:false, reason } for the page. In a test run (env.test) a write must be a dry run.
 */
module.exports = {
  id: 'example',
  commands: {
    async get(_args, env) {
      return { ok: true, glow: !!env.settings.get('glow', false) };
    },
    async setGlow(args, env) {
      if (typeof args.on !== 'boolean') return { ok: false, reason: 'on must be true or false' };
      if (env.test) return { ok: true, dryRun: true, reason: 'test run: nothing was changed' };   // the switch springs back
      env.settings.set('glow', args.on);
      return { ok: true, value: args.on };             // the read-back: what the switch shows
    },
  },
  install(env) {
    const off = env.onRest(({ on }) => { if (on) env.log('a game started; nothing to let go of'); });
    return () => off();
  },
};
